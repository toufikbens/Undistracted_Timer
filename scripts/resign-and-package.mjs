import { execSync } from "child_process";
import { existsSync, rmSync, mkdirSync, cpSync, symlinkSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const APP_NAME = "Undistracted Timer";
const VERSION = "0.1.0";
const APP_PATH = join(ROOT, `src-tauri/target/release/bundle/macos/${APP_NAME}.app`);
const DMG_DIR = join(ROOT, "src-tauri/target/release/bundle/dmg");
const DMG_NAME = `${APP_NAME}_${VERSION}_aarch64.dmg`;
const STAGING = "/tmp/undistracted-dmg-staging";

if (!existsSync(APP_PATH)) {
  console.error("App not found at", APP_PATH);
  process.exit(1);
}

// 1. Re-sign with proper resource sealing
console.log("Re-signing app bundle...");
execSync(`codesign --force --deep --sign - "${APP_PATH}"`, { stdio: "inherit" });

// 2. Verify
console.log("Verifying signature...");
execSync(`codesign --verify --verbose "${APP_PATH}"`, { stdio: "inherit" });

// 3. Rebuild DMG
console.log("Rebuilding DMG...");
const APP_IN_DMG = join(STAGING, `${APP_NAME}.app`);

// Clean staging
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
mkdirSync(STAGING, { recursive: true });

cpSync(APP_PATH, APP_IN_DMG, { recursive: true });
symlinkSync("/Applications", join(STAGING, "Applications"));

// Remove stale DMG
if (existsSync(join(DMG_DIR, DMG_NAME))) rmSync(join(DMG_DIR, DMG_NAME));

execSync(
  `hdiutil create -volname "${APP_NAME}" -srcfolder "${STAGING}" -ov -format UDZO -imagekey zlib-level=9 "${join(DMG_DIR, DMG_NAME)}"`,
  { stdio: "inherit" }
);

// Cleanup
rmSync(STAGING, { recursive: true });

console.log("Done. DMG rebuilt with valid ad-hoc signature.");
