import Script from "next/script";

export const dynamic = "force-dynamic";
export const metadata = { title: "苦痛之路运行实例" };

export default function PracticeRunnerPage() {
  return (
    <>
      <link rel="stylesheet" href="/static/unity-practice-runner.css?v=16x9" />
      <div id="unity-container">
        <canvas id="unity-canvas" tabIndex={-1} aria-label="Hollow Knight" />
        <div id="unity-warning" aria-live="polite" />
      </div>
      <Script src="/static/unity-practice-runner.js?v=16x9" strategy="afterInteractive" />
    </>
  );
}
