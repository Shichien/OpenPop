export const UNITY_VERSIONS = [
  { id: "1.5.78.11833", directory: "practice-1.5.78.11833" },
  { id: "1.5.12620", directory: "practice-1.5.12620-live-timer-v57-formal" },
] as const;

export const DEFAULT_UNITY_VERSION = "1.5.12620";

export const PRACTICE_ROUTES: Readonly<Record<string, readonly [string, string]>> = {
  White_Palace_18: ["White_Palace_06", "White_Palace_17"],
  White_Palace_17: ["White_Palace_18", "White_Palace_19"],
  White_Palace_19: ["White_Palace_17", "White_Palace_20"],
  White_Palace_20: ["White_Palace_19", "White_Palace_06"],
};

export const PRACTICE_ROOMS = Object.freeze(Object.keys(PRACTICE_ROUTES));

export const CAMERA_PROJECTION = Object.freeze({
  baseline_world_height: 16.196809350584537,
  minimum_aspect: 1.6,
  maximum_aspect: 2.3916667,
});

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
