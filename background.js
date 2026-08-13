const DEBUGGER_VERSION = "1.3";
const CAPTURE_SCALES = [1, 0.75, 0.5, 0.25];
const MAX_CAPTURE_PIXELS = 64_000_000;
const MAX_CAPTURE_DIMENSION = 100_000;
const capturesInProgress = new Set();

chrome.action.onClicked.addListener((tab) => {
  void captureFullPage(tab);
});

async function captureFullPage(tab) {
  if (!tab.id || capturesInProgress.has(tab.id)) {
    return;
  }

  const tabId = tab.id;
  const target = { tabId };
  let debuggerAttached = false;
  let originalScrollPosition = null;

  capturesInProgress.add(tabId);
  await showWorking(tabId);

  try {
    assertCapturableUrl(tab.url);

    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    debuggerAttached = true;

    await send(target, "Page.enable");
    await send(target, "Runtime.enable");

    originalScrollPosition = await preparePage(target);

    const metrics = await send(target, "Page.getLayoutMetrics");
    const contentSize = metrics.cssContentSize || metrics.contentSize;
    const width = Math.ceil(contentSize.width);
    const height = Math.ceil(contentSize.height);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error("Chrome не смог определить размер страницы.");
    }

    const screenshot = await captureAtHighestPossibleResolution(target, width, height);

    if (originalScrollPosition) {
      await restoreScrollPosition(target, originalScrollPosition);
      originalScrollPosition = null;
    }

    await chrome.debugger.detach(target);
    debuggerAttached = false;

    const filename = buildFilename(tab.url);
    await chrome.downloads.download({
      url: `data:image/png;base64,${screenshot.data}`,
      filename,
      conflictAction: "uniquify",
      saveAs: false
    });

    const dimensions = readPngDimensions(screenshot.data);
    await showSuccess(tabId, filename, dimensions, screenshot.scale);
  } catch (error) {
    console.error("Full Page PNG capture failed", error);
    await showError(tabId, humanizeError(error));
  } finally {
    if (debuggerAttached) {
      if (originalScrollPosition) {
        try {
          await restoreScrollPosition(target, originalScrollPosition);
        } catch (error) {
          console.warn("Could not restore scroll position", error);
        }
      }

      try {
        await chrome.debugger.detach(target);
      } catch (error) {
        console.warn("Could not detach debugger", error);
      }
    }

    capturesInProgress.delete(tabId);
  }
}

async function preparePage(target) {
  const result = await send(target, "Runtime.evaluate", {
    expression: `
      (async () => {
        const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const scrollingElement = document.scrollingElement || document.documentElement;
        const originalPosition = { x: window.scrollX, y: window.scrollY };
        const initialHeight = Math.max(
          scrollingElement?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        const step = Math.max(Math.floor(window.innerHeight * 0.85), 600);
        const maximumSteps = 60;

        window.scrollTo(0, 0);
        await sleep(80);

        for (let y = 0, count = 0; y < initialHeight && count < maximumSteps; y += step, count += 1) {
          window.scrollTo(0, y);
          await sleep(70);
        }

        window.scrollTo(0, initialHeight);
        await sleep(180);
        window.scrollTo(0, 0);
        await sleep(250);

        return originalPosition;
      })()
    `,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error("Страница не разрешила подготовить отложенные изображения.");
  }

  return result.result?.value || { x: 0, y: 0 };
}

async function restoreScrollPosition(target, position) {
  await send(target, "Runtime.evaluate", {
    expression: `window.scrollTo(${toFiniteNumber(position.x)}, ${toFiniteNumber(position.y)})`
  });
}

async function captureAtHighestPossibleResolution(target, width, height) {
  let lastError;
  let attemptedCapture = false;

  for (const scale of CAPTURE_SCALES) {
    if (!isSafeCaptureSize(width, height, scale)) {
      continue;
    }

    attemptedCapture = true;

    try {
      const result = await send(target, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        optimizeForSpeed: false,
        clip: {
          x: 0,
          y: 0,
          width,
          height,
          scale
        }
      });

      if (!result.data) {
        throw new Error("Chrome вернул пустой снимок.");
      }

      return { data: result.data, scale };
    } catch (error) {
      lastError = error;
      console.warn(`Capture at scale ${scale} failed`, error);
    }
  }

  if (!attemptedCapture) {
    throw new Error("Страница слишком велика для безопасного создания одного PNG.");
  }

  throw lastError || new Error("Не удалось создать PNG.");
}

function isSafeCaptureSize(width, height, scale) {
  const outputWidth = width * scale;
  const outputHeight = height * scale;

  return outputWidth <= MAX_CAPTURE_DIMENSION &&
    outputHeight <= MAX_CAPTURE_DIMENSION &&
    outputWidth * outputHeight <= MAX_CAPTURE_PIXELS;
}

function assertCapturableUrl(url = "") {
  const isRegularPage = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://");
  const isChromeWebStore = url.startsWith("https://chromewebstore.google.com/") ||
    url.startsWith("https://chrome.google.com/webstore/");

  if (!isRegularPage || isChromeWebStore) {
    throw new Error("Эту служебную страницу Chrome нельзя снять расширением.");
  }
}

function buildFilename(url = "") {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-") + "_" + [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("-");

  let host = "web-page";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || "web-page";
  } catch {
    // Keep the fallback name.
  }

  const safeHost = host
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "web-page";

  return `${safeHost} - ${timestamp}.png`;
}

function readPngDimensions(base64) {
  try {
    const binary = atob(base64.slice(0, 48));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length < 24) {
      return null;
    }

    const view = new DataView(bytes.buffer);
    return {
      width: view.getUint32(16),
      height: view.getUint32(20)
    };
  } catch {
    return null;
  }
}

async function showWorking(tabId) {
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563EB" }),
    chrome.action.setBadgeText({ tabId, text: "…" }),
    chrome.action.setTitle({ tabId, title: "Снимаю всю страницу…" })
  ]);
}

async function showSuccess(tabId, filename, dimensions, scale) {
  const sizeText = dimensions ? ` (${dimensions.width}×${dimensions.height})` : "";
  const scaleText = scale < 1 ? `, масштаб ${Math.round(scale * 100)}%` : "";

  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#16A34A" }),
    chrome.action.setBadgeText({ tabId, text: "✓" }),
    chrome.action.setTitle({
      tabId,
      title: `Сохранено: ${filename}${sizeText}${scaleText}`
    })
  ]);
}

async function showError(tabId, message) {
  await Promise.allSettled([
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#DC2626" }),
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setTitle({ tabId, title: `Ошибка: ${message}` })
  ]);
}

function humanizeError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (/Another debugger|already attached|Cannot attach/i.test(message)) {
    return "Закройте DevTools для этой вкладки и повторите попытку.";
  }

  if (/Cannot access|not allowed|permission/i.test(message)) {
    return "Chrome не разрешает делать снимок этой страницы.";
  }

  return message || "Не удалось создать снимок.";
}

function send(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
