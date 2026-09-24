import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

import { writeDemoDataset } from "./generate-demo";

const ROOT = resolve(import.meta.dir, "..");
const WIDTH = 1920;
const HEIGHT = 1080;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;
const DEVICE_SCALE = 1.5;
const THEMES = ["EDM115", "catppuccin-latte", "codex-dark", "matrix-dark"] as const;
const TOP_CUTS = [820, 1296, 1779];
const DIAGONAL_SHIFT = 668 / HEIGHT;

type Rectangle = { x: number; y: number; width: number; height: number };

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString() !== "PNG") throw new Error("Browser did not return a PNG screenshot");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function assertSameGeometry(reference: Rectangle[], current: Rectangle[], theme: string): void {
  for (let index = 0; index < reference.length; index++) {
    for (const key of ["x", "y", "width", "height"] as const) {
      if (Math.abs(reference[index][key] - current[index][key]) > 0.1) throw new Error(`${theme} moved report element ${index} (${key}: ${reference[index][key]} -> ${current[index][key]})`);
    }
  }
}

async function main(): Promise<void> {
  process.chdir(ROOT);
  const { reportPath } = await writeDemoDataset({ report: true });
  if (!reportPath) throw new Error("Demo report was not generated");

  const browser = await chromium.launch(process.env.DEMO_CHROME_PATH ? { executablePath: process.env.DEMO_CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }, deviceScaleFactor: DEVICE_SCALE, locale: "en-US", timezoneId: "Europe/Paris", colorScheme: "dark" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(pathToFileURL(reportPath).href);
    await page.waitForFunction(() => (document.querySelector("#heatmap")?.children.length ?? 0) > 0);
    await page.locator("#mode").selectOption("daily");
    await page.locator("#chartStyle").selectOption("auto");
    await page.locator("#rangePreset").selectOption("all");
    await page.locator("#rawCounts").uncheck();
    if (await page.locator("#rangePreset").inputValue() !== "all") throw new Error("All time range was not selected");

    const captureDir = join(ROOT, "output", "demo-capture");
    mkdirSync(captureDir, { recursive: true });
    const shots: Buffer[] = [];
    let referenceGeometry: Rectangle[] | undefined;

    for (const theme of THEMES) {
      await page.locator("#themePickerButton").click();
      await page.locator("#themeSearch").fill(theme);
      await page.getByRole("option", { name: theme, exact: true }).click();
      await page.waitForFunction((name) => document.querySelector("#themePickerLabel")?.textContent === name, theme);
      await page.evaluate(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        await document.fonts.ready;
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
      await page.mouse.move(0, 0);
      await page.evaluate(() => scrollTo(0, 0));

      const geometry = await page.evaluate(() => ["header", ".stats", ".section", "#heatmap"].map((selector) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }));
      if (referenceGeometry) assertSameGeometry(referenceGeometry, geometry, theme);
      else referenceGeometry = geometry;

      const shot = await page.screenshot({ type: "png", animations: "disabled", scale: "device" });
      const size = pngSize(shot);
      if (size.width !== WIDTH || size.height !== HEIGHT) throw new Error(`${theme} screenshot is ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`);
      writeFileSync(join(captureDir, `${theme}.png`), shot);
      shots.push(shot);
    }
    if (pageErrors.length) throw new Error(`Demo page error: ${pageErrors.join(" | ")}`);

    const base64 = await page.evaluate(async ({ sources, width, height, topCuts, diagonalShift }) => {
      const images = await Promise.all(sources.map(async (source) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        if (image.width !== width || image.height !== height) throw new Error("Source screenshot dimensions differ");
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("2D canvas is unavailable");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      }));
      const result = document.createElement("canvas");
      result.width = width;
      result.height = height;
      const context = result.getContext("2d");
      if (!context) throw new Error("2D canvas is unavailable");
      const composite = context.createImageData(width, height);
      for (let y = 0; y < height; y++) {
        const cuts = [0, ...topCuts.map((cut) => Math.max(0, Math.min(width, Math.round(cut - diagonalShift * y)))), width];
        for (let theme = 0; theme < images.length; theme++) {
          const start = (y * width + cuts[theme]) * 4;
          const end = (y * width + cuts[theme + 1]) * 4;
          composite.data.set(images[theme].subarray(start, end), start);
        }
      }
      context.putImageData(composite, 0, 0);
      return result.toDataURL("image/png").split(",")[1];
    }, { sources: shots.map((shot) => `data:image/png;base64,${shot.toString("base64")}`), width: WIDTH, height: HEIGHT, topCuts: TOP_CUTS, diagonalShift: DIAGONAL_SHIFT });
    const output = Buffer.from(base64, "base64");
    const size = pngSize(output);
    if (size.width !== WIDTH || size.height !== HEIGHT) throw new Error("Composite image dimensions differ");
    const outputPath = join(ROOT, "demo.png");
    writeFileSync(outputPath, output);
    console.log(`Generated ${outputPath} (${WIDTH}x${HEIGHT}) from ${THEMES.join(", ")}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

await main();
