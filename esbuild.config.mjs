import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
const watch = process.argv.includes("--watch");

const workerOptions = {
  ...presets.esbuild.worker,
  external: [
    ...(presets.esbuild.worker.external ?? []),
    "@slack/socket-mode",
  ],
};

const workerCtx = await esbuild.context(workerOptions);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
