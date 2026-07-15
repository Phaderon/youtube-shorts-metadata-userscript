// ==UserScript==
// @name         YouTube Shorts Metadata
// @namespace    local.youtube.shorts.metadata
// @version      0.1.0
// @description  Adds upload date and duration back onto YouTube Shorts cards in search, subscriptions, and grids.
// @match        https://www.youtube.com/*
// @match        https://youtube.com/*
// @homepageURL  https://github.com/Phaderon/youtube-shorts-metadata-userscript
// @supportURL   https://github.com/Phaderon/youtube-shorts-metadata-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/Phaderon/youtube-shorts-metadata-userscript/main/youtube-shorts-metadata.user.js
// @updateURL    https://raw.githubusercontent.com/Phaderon/youtube-shorts-metadata-userscript/main/youtube-shorts-metadata.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT = "yt-sm";
  const CARD_ATTR = `data-${SCRIPT}-card`;
  const META_ATTR = `data-${SCRIPT}-meta`;
  const QUEUED_ATTR = `data-${SCRIPT}-queued`;
  const CACHE_KEY = `${SCRIPT}.cache.v1`;
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const MAX_CACHE_ITEMS = 900;
  const MAX_CONCURRENT = 3;

  const cache = loadCache();
  const pending = [];
  const inFlight = new Set();
  let scanTimer = 0;

  injectStyles();
  scan();
  observePage();
  document.addEventListener("yt-navigate-finish", scheduleScan, true);
  window.addEventListener("popstate", scheduleScan, true);

  function observePage() {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 250);
  }

  function scan() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/shorts/"]'));
    for (const anchor of anchors) {
      const videoId = getShortId(anchor.href || anchor.getAttribute("href"));
      if (!videoId) continue;

      const card = findCard(anchor);
      if (!card || card.getAttribute(CARD_ATTR) === videoId) continue;

      card.setAttribute(CARD_ATTR, videoId);
      card.classList.add(`${SCRIPT}-card`);
      ensureShell(card, anchor);

      const cached = getCached(videoId);
      if (cached) {
        render(card, cached);
      } else if (!card.hasAttribute(QUEUED_ATTR)) {
        card.setAttribute(QUEUED_ATTR, "1");
        enqueue(videoId, card);
      }
    }
  }

  function getShortId(href) {
    if (!href) return "";
    const match = String(href).match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
    return match ? match[1] : "";
  }

  function findCard(anchor) {
    const direct = anchor.closest([
      "ytd-rich-item-renderer",
      "ytd-video-renderer",
      "ytd-reel-item-renderer",
      "ytd-grid-video-renderer",
      "ytm-shorts-lockup-view-model",
      "yt-lockup-view-model",
      "ytm-rich-item-renderer",
      "ytm-video-with-context-renderer",
    ].join(","));
    if (direct) return direct;

    let node = anchor;
    for (let i = 0; i < 7 && node && node.parentElement; i += 1) {
      node = node.parentElement;
      if (node.querySelector?.("img") && node.textContent.trim().length > 15) {
        return node;
      }
    }
    return anchor.parentElement;
  }

  function ensureShell(card, anchor) {
    const thumb = findThumbnailBox(card, anchor);
    if (thumb && !thumb.querySelector(`.${SCRIPT}-duration`)) {
      const computed = getComputedStyle(thumb);
      if (computed.position === "static") thumb.style.position = "relative";

      const badge = document.createElement("span");
      badge.className = `${SCRIPT}-duration`;
      badge.textContent = "...";
      thumb.appendChild(badge);
    }

    if (!card.querySelector(`.${SCRIPT}-line`)) {
      const line = document.createElement("div");
      line.className = `${SCRIPT}-line`;
      line.textContent = "Loading date...";
      const target = findMetadataTarget(card, anchor);
      target.appendChild(line);
    }
  }

  function findThumbnailBox(card, anchor) {
    return anchor.querySelector("yt-image, img") ? anchor : (
      card.querySelector("a[href*='/shorts/'] yt-image")?.closest("a") ||
      card.querySelector("a[href*='/shorts/'] img")?.closest("a") ||
      card.querySelector("ytd-thumbnail, yt-thumbnail-view-model, .yt-thumbnail-view-model") ||
      anchor
    );
  }

  function findMetadataTarget(card, anchor) {
    const title = card.querySelector("#video-title, yt-formatted-string#video-title, a[title], h3, .yt-lockup-metadata-view-model-wiz__text-container");
    const holder = title?.closest("#details, #dismissible, .details, .metadata, .yt-lockup-metadata-view-model-wiz__text-container");
    if (holder && holder !== card) return holder;

    let node = anchor;
    for (let i = 0; i < 5 && node?.parentElement; i += 1) {
      node = node.parentElement;
      if (node !== card && node.textContent.trim().length > 20) return node;
    }
    return card;
  }

  function enqueue(videoId, card) {
    pending.push({ videoId, card });
    pumpQueue();
  }

  function pumpQueue() {
    while (inFlight.size < MAX_CONCURRENT && pending.length) {
      const item = pending.shift();
      if (!item.card.isConnected) continue;

      const cached = getCached(item.videoId);
      if (cached) {
        render(item.card, cached);
        continue;
      }

      inFlight.add(item.videoId);
      fetchMetadata(item.videoId)
        .then((meta) => {
          setCached(item.videoId, meta);
          renderEverywhere(item.videoId, meta);
        })
        .catch(() => {
          render(item.card, {
            durationText: "?",
            dateText: "Date unavailable",
            exactDate: "",
          });
        })
        .finally(() => {
          inFlight.delete(item.videoId);
          pumpQueue();
        });
    }
  }

  async function fetchMetadata(videoId) {
    const response = await fetch(`/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`, {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`watch page ${response.status}`);

    const html = await response.text();
    const seconds = firstMatch(html, /"lengthSeconds":"(\d+)"/);
    const rawDate =
      firstMatch(html, /"publishDate":"([^"]+)"/) ||
      firstMatch(html, /"uploadDate":"([^"]+)"/) ||
      firstMatch(html, /"datePublished" content="([^"]+)"/);

    if (!seconds && !rawDate) throw new Error("metadata not found");

    return {
      durationText: seconds ? formatDuration(Number(seconds)) : "?",
      dateText: rawDate ? formatDate(rawDate) : "Date unavailable",
      exactDate: rawDate ? formatExactDate(rawDate) : "",
      fetchedAt: Date.now(),
    };
  }

  function firstMatch(text, regex) {
    const match = text.match(regex);
    return match ? decodeHtml(match[1]) : "";
  }

  function renderEverywhere(videoId, meta) {
    for (const card of document.querySelectorAll(`[${CARD_ATTR}="${CSS.escape(videoId)}"]`)) {
      render(card, meta);
    }
  }

  function render(card, meta) {
    const duration = card.querySelector(`.${SCRIPT}-duration`);
    if (duration) {
      duration.textContent = meta.durationText || "?";
      duration.title = "Short duration";
    }

    const line = card.querySelector(`.${SCRIPT}-line`);
    if (line) {
      line.textContent = meta.dateText || "Date unavailable";
      line.title = meta.exactDate ? `Uploaded ${meta.exactDate}` : "";
      line.setAttribute(META_ATTR, "ready");
    }
  }

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "?";
    const seconds = Math.floor(totalSeconds);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatDate(rawDate) {
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return rawDate.slice(0, 10);

    const days = Math.round((startOfToday().getTime() - startOfDay(date).getTime()) / 86400000);
    if (days === 0) return "Uploaded today";
    if (days === 1) return "Uploaded yesterday";
    if (days < 14) return `Uploaded ${days} days ago`;

    return `Uploaded ${date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })}`;
  }

  function formatExactDate(rawDate) {
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return rawDate;
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function startOfToday() {
    return startOfDay(new Date());
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function decodeHtml(value) {
    return value
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function loadCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveCache() {
    const entries = Object.entries(cache)
      .sort((a, b) => (b[1].fetchedAt || 0) - (a[1].fetchedAt || 0))
      .slice(0, MAX_CACHE_ITEMS);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  }

  function getCached(videoId) {
    const item = cache[videoId];
    if (!item || Date.now() - (item.fetchedAt || 0) > CACHE_TTL_MS) {
      delete cache[videoId];
      return null;
    }
    return item;
  }

  function setCached(videoId, meta) {
    cache[videoId] = { ...meta, fetchedAt: Date.now() };
    saveCache();
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .${SCRIPT}-duration {
        position: absolute;
        right: 6px;
        bottom: 6px;
        z-index: 10;
        display: inline-flex;
        align-items: center;
        min-height: 18px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(0, 0, 0, .84);
        color: #fff;
        font: 600 12px/16px Roboto, Arial, sans-serif;
        letter-spacing: 0;
        pointer-events: none;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .35);
      }

      .${SCRIPT}-line {
        margin-top: 2px;
        color: var(--yt-spec-text-secondary, #aaa);
        font: 400 12px/16px Roboto, Arial, sans-serif;
        letter-spacing: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${SCRIPT}-line[${META_ATTR}="ready"] {
        color: var(--yt-spec-text-secondary, #aaa);
      }

      ytd-video-renderer .${SCRIPT}-line,
      ytd-rich-item-renderer .${SCRIPT}-line {
        font-size: 13px;
        line-height: 18px;
      }
    `;
    document.documentElement.appendChild(style);
  }
})();
