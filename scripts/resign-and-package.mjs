import { execSync } from "child_process";
import { existsSync, rmSync, mkdirSync, cpSync } from "fs";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname;
const APP_NAME = "Undistracted Timer";
const VERSION = "0.1.0";
// Optional first argument: a Tauri build target (defaults to universal).
// Example: node scripts/resign-and-package.mjs aarch64-apple-darwin
const TARGET = process.argv[2] || "universal-apple-darwin";
const ARCH_SUFFIX = TARGET === "universal-apple-darwin"
  ? "universal"
  : TARGET.includes("aarch64")
    ? "arm64"
    : TARGET;
const RELEASE_DIR = join(ROOT, "src-tauri/target", TARGET, "release");
const APP_PATH = join(RELEASE_DIR, `bundle/macos/${APP_NAME}.app`);
const DMG_DIR = join(RELEASE_DIR, "bundle/dmg");
const DMG_NAME = `${APP_NAME}_${VERSION}_${ARCH_SUFFIX}.dmg`;
const DIST_DIR = join(ROOT, "dist");
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

// 3. Stage the app
console.log("Staging app...");
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
mkdirSync(STAGING, { recursive: true });
cpSync(APP_PATH, join(STAGING, `${APP_NAME}.app`), { recursive: true });

// 4. Rebuild DMG
console.log("Rebuilding DMG...");
if (existsSync(join(DMG_DIR, DMG_NAME))) rmSync(join(DMG_DIR, DMG_NAME));

execSync(
  `create-dmg` +
  ` --volname "${APP_NAME}"` +
  ` --window-pos 200 120` +
  ` --window-size 540 380` +
  ` --icon-size 120` +
  ` --icon "${APP_NAME}.app" 140 190` +
  ` --app-drop-link 400 190` +
  ` --no-internet-enable` +
  ` "${join(DMG_DIR, DMG_NAME)}"` +
  ` "${STAGING}"`,
  { stdio: "inherit", shell: true }
);

// 5. Copy final artifacts to dist/
console.log("Copying to dist/...");
mkdirSync(DIST_DIR, { recursive: true });
cpSync(APP_PATH, join(DIST_DIR, `${APP_NAME}.app`), { recursive: true });
cpSync(join(DMG_DIR, DMG_NAME), join(DIST_DIR, DMG_NAME), { recursive: true });

// Cleanup
rmSync(STAGING, { recursive: true });

console.log(`Done.\n  ${join(DIST_DIR, `${APP_NAME}.app`)}\n  ${join(DIST_DIR, DMG_NAME)}`);
