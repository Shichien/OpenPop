from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import app  # noqa: E402
from pop_app.replay_parser import decode_share_string  # noqa: E402


class PopServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)

    def test_health_and_builds_are_self_contained(self) -> None:
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.json()["ok"])

        payload = self.client.get("/api/practice/builds").json()
        self.assertEqual(payload["defaultVersion"], "1.5.12620")
        self.assertEqual(payload["initialLoadCount"], 1)
        self.assertEqual({item["id"] for item in payload["versions"]}, {"1.5.78.11833", "1.5.12620"})
        self.assertTrue(all(item["available"] for item in payload["versions"]))
        self.assertTrue(all(item["loaderUrl"].startswith("/unity-practice-builds/") for item in payload["versions"]))
        self.assertTrue(all(item["compression"] in {"none", "brotli"} for item in payload["versions"]))

    def test_deployment_cache_headers(self) -> None:
        page = self.client.get("/")
        self.assertEqual(page.headers["cache-control"], "no-store")

        builds = self.client.get("/api/practice/builds").json()["versions"]
        loader_url = builds[0]["loaderUrl"]
        loader = self.client.get(loader_url)
        self.assertEqual(loader.status_code, 200)
        self.assertEqual(loader.headers["cache-control"], "public, max-age=31536000, immutable")

    def test_practice_page_and_runner_are_served(self) -> None:
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("苦痛之路", page.text)
        self.assertIn("/static/unity-practice.js", page.text)

        runner = self.client.get("/practice/runner?version=1.5.12620")
        self.assertEqual(runner.status_code, 200)
        self.assertIn("unity-canvas", runner.text)

    def test_hero_manifest_uses_local_generated_urls(self) -> None:
        response = self.client.get("/api/hero-animation?game=hollow_knight")
        self.assertEqual(response.status_code, 200)
        atlases = response.json()["hero"]["atlases"]
        self.assertTrue(atlases)
        self.assertTrue(all(atlas["image_url"].startswith("/generated/hero/") for atlas in atlases.values()))

    def test_practice_replay_and_social_endpoints(self) -> None:
        replay = self.client.get("/api/practice/replay?scene_name=White_Palace_18")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["scene_name"], "White_Palace_18")
        self.assertGreater(replay.json()["projection"]["baseline_world_height"], 0)

        leaderboard = self.client.get("/api/social/leaderboards/White_Palace_18")
        self.assertEqual(leaderboard.status_code, 200)
        self.assertIn("runs", leaderboard.json())

    def test_recording_exports_rtmc(self) -> None:
        response = self.client.post(
            "/api/practice/replay/export",
            json={
                "format": "original-practice-replay-v1",
                "gameVersion": "1.5.12620",
                "sceneName": "White_Palace_18",
                "entryFromScene": "White_Palace_06",
                "exitToScene": "White_Palace_17",
                "totalTime": 0.033,
                "frames": [
                    {"elapsed": 0.0, "x": 10.0, "y": 20.0, "facingRight": True, "animClip": "Idle", "animFrame": 0},
                    {"elapsed": 0.033, "x": 10.1, "y": 20.0, "facingRight": True, "animClip": "Run", "animFrame": 1},
                ],
            },
        )
        self.assertEqual(response.status_code, 200)
        rooms = decode_share_string(response.json()["shareText"])
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0].key.scene_name, "White_Palace_18")
        self.assertEqual(rooms[0].key.exit_to_scene, "White_Palace_17")
        self.assertEqual(rooms[0].frame_count, 2)


if __name__ == "__main__":
    unittest.main()
