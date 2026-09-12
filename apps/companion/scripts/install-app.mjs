import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildApp, installedApp, bundleName, requireMac, run, verifyBundle } from "./app-bundle.mjs";

requireMac();
verifyBundle(buildApp);
const applications = dirname(installedApp);
await mkdir(applications, { recursive: true });
let exists = false;
try {
  const info = await lstat(installedApp);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("The install destination is not an app directory.");
  verifyBundle(installedApp); exists = true;
} catch (error) { if (error.code !== "ENOENT") throw error; }
// Never replace a live executable or stop a user's runner implicitly.
const processes = run("/bin/ps", ["-axo", "comm="]).split("\n");
if (processes.some(path => path.trim().startsWith(installedApp + "/"))) {
  throw new Error("Quit Hablabla Companion and stop its Terminal runner before installing an update.");
}
const staging = await mkdtemp(join(applications, ".hablabla-install-"));
const backup = join(staging, "previous.app");
try {
  const copy = join(staging, bundleName);
  await cp(buildApp, copy, { recursive: true, errorOnExist: true, force: false });
  verifyBundle(copy);
  if (exists) await rename(installedApp, backup);
  try { await rename(copy, installedApp); }
  catch (error) { if (exists) await rename(backup, installedApp); throw error; }
  console.log(`Installed ${installedApp}`);
  console.log("Run npm run companion -- app to show the background helper. Pairing and approval still use Terminal.");
} finally { await rm(staging, { recursive: true, force: true }); }
