import "server-only";

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_UNITY_VERSION, UNITY_VERSIONS } from "@/lib/constants";
import { r2PublicUrl, unityBuildDirectory } from "@/lib/config";

type CatalogEntry = {
  directory?: string;
  compression?: string;
  replayCaptureAvailable?: boolean;
  files?: Partial<Record<"dataUrl" | "frameworkUrl" | "codeUrl", string>>;
};

export type PracticeBuild = {
  id: string;
  label: string;
  available: boolean;
  error?: string;
  replayCaptureAvailable?: boolean;
  loaderUrl?: string;
  dataUrl?: string;
  frameworkUrl?: string;
  codeUrl?: string;
  streamingAssetsUrl?: string;
  r2Enabled?: boolean;
  compression?: string;
  companyName?: string;
  productName?: string;
  productVersion?: string;
};

function buildCatalog(): Record<string, CatalogEntry> {
  const path = resolve(unityBuildDirectory, "build-manifest.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { versions?: Record<string, CatalogEntry> };
  return parsed.versions ?? {};
}

export function practiceBuildManifest(version: (typeof UNITY_VERSIONS)[number]): PracticeBuild {
  const buildDirectory = resolve(unityBuildDirectory, version.directory);
  const filesDirectory = resolve(buildDirectory, "Build");
  const result: PracticeBuild = { id: version.id, label: version.id, available: false };
  if (!existsSync(resolve(buildDirectory, "index.html")) || !existsSync(filesDirectory)) {
    return { ...result, error: `${version.id} 的运行包尚未生成` };
  }
  const loaderFiles = readdirSync(filesDirectory).filter((name) => name.endsWith(".loader.js"));
  if (loaderFiles.length !== 1) return { ...result, error: `${version.id} 的 Unity 加载器数量不正确` };
  const catalog = buildCatalog()[version.id] ?? {};
  const catalogFiles = catalog.files ?? {};
  const buildName = loaderFiles[0].slice(0, -".loader.js".length);
  const candidates = {
    dataUrl: catalogFiles.dataUrl || `${buildName}.data.br`,
    frameworkUrl: catalogFiles.frameworkUrl || `${buildName}.framework.js.br`,
    codeUrl: catalogFiles.codeUrl || `${buildName}.wasm.br`,
  };
  if (!candidates.dataUrl || !candidates.frameworkUrl || !candidates.codeUrl) {
    return { ...result, error: `${version.id} 的大型文件清单不完整` };
  }
  const localRoot = `/unity-practice-builds/${version.directory}`;
  const largeRoot = r2PublicUrl ? `${r2PublicUrl}${localRoot}` : localRoot;
  return {
    ...result,
    available: true,
    replayCaptureAvailable: Boolean(catalog.replayCaptureAvailable),
    loaderUrl: `${localRoot}/Build/${loaderFiles[0]}`,
    dataUrl: `${largeRoot}/Build/${candidates.dataUrl}`,
    frameworkUrl: `${largeRoot}/Build/${candidates.frameworkUrl}`,
    codeUrl: `${largeRoot}/Build/${candidates.codeUrl}`,
    streamingAssetsUrl: `${localRoot}/StreamingAssets`,
    r2Enabled: Boolean(r2PublicUrl),
    compression: catalog.compression || "brotli",
    companyName: "Team Cherry",
    productName: "Hollow Knight",
    productVersion: version.id,
  };
}

export function practiceBuildsPayload() {
  return {
    defaultVersion: DEFAULT_UNITY_VERSION,
    initialLoadCount: 1,
    versions: UNITY_VERSIONS.map(practiceBuildManifest),
  };
}

export function healthPayload() {
  const versions = UNITY_VERSIONS.map(practiceBuildManifest);
  return { ok: versions.every((version) => version.available), project: "pop", versions };
}
