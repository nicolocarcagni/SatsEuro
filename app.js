"use strict";

const SATS_PER_BTC = 100_000_000;
const API_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur";
const REFRESH_MS = 60_000;
const DEBOUNCE_MS = 250;
const MAX_EUR_DP = 2;

const satsInput = document.getElementById("sats-input");
const eurInput = document.getElementById("eur-input");
const rateDisplay = document.getElementById("rate-display");
const statusMessage = document.getElementById("status-message");

let btcToEurRate = null;
let refreshTimer = null;
let lastActiveInput = satsInput;

// Guards against conversion loops when we programmatically set a field value.
let isProgrammaticUpdate = false;

const fmtRate = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
});


// ---------------------------------------------------------------------------
//  Utilities
// ---------------------------------------------------------------------------

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function parseSatsDisplay(str) {
    if (!str) return NaN;
    return Number(str.replace(/\s/g, ""));
}

function parseEurDisplay(str) {
    if (!str) return NaN;
    return Number(str.replace(/\s/g, ""));
}

/** Inserts space thousand separators into a pure-digit string. */
function formatSatsString(raw) {
    if (!raw) return "";
    return raw.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function formatEurString(raw) {
    return raw;
}


// ---------------------------------------------------------------------------
//  Input validation — keydown gate
// ---------------------------------------------------------------------------

/**
 * First line of defence: blocks non-numeric keys at the keyboard level.
 * Commas in the EUR field are silently replaced with a dot so the user
 * never has to remember which separator to use.
 */
function attachKeydownGuard(inputEl, allowDot) {
    inputEl.addEventListener("keydown", (e) => {
        const key = e.key;

        if (
            key === "Backspace" || key === "Delete" ||
            key === "ArrowLeft" || key === "ArrowRight" ||
            key === "ArrowUp" || key === "ArrowDown" ||
            key === "Tab" || key === "Enter" ||
            key === "Home" || key === "End" ||
            e.ctrlKey || e.metaKey
        ) {
            return;
        }

        if (/^\d$/.test(key)) return;

        // Comma → dot coercion (EUR only)
        if (key === "," && allowDot) {
            e.preventDefault();
            insertCharAtCaret(inputEl, ".");
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }

        if (key === "." && allowDot) {
            if (inputEl.value.includes(".")) e.preventDefault();
            return;
        }

        e.preventDefault();
    });
}

function insertCharAtCaret(inputEl, char) {
    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
    const value = inputEl.value;

    inputEl.value = value.slice(0, start) + char + value.slice(end);
    inputEl.selectionStart = inputEl.selectionEnd = start + 1;
}

attachKeydownGuard(satsInput, false);
attachKeydownGuard(eurInput, true);


// ---------------------------------------------------------------------------
//  Live formatting with caret preservation
// ---------------------------------------------------------------------------

/**
 * Sanitises, re-formats, and restores the caret in the SATS field.
 *
 * Caret strategy: we track the user's "digit index" (how many real digits
 * sit to the left of the caret) before formatting, then walk the formatted
 * string to place the caret at the same digit index — skipping any
 * newly-inserted spaces.
 */
function handleSatsInput() {
    if (isProgrammaticUpdate) return;

    const el = satsInput;
    const raw = el.value;
    const caret = el.selectionStart;

    const spacesBeforeCaret = (raw.slice(0, caret).match(/\s/g) || []).length;
    const digits = raw.replace(/\D/g, "");
    const formatted = formatSatsString(digits);

    if (el.value !== formatted) el.value = formatted;

    const digitIndexAtCaret = caret - spacesBeforeCaret;
    let newCaret = 0;
    let digitsSeen = 0;

    for (let i = 0; i < formatted.length; i++) {
        if (formatted[i] !== " ") digitsSeen++;
        if (digitsSeen === digitIndexAtCaret) { newCaret = i + 1; break; }
    }
    if (digitIndexAtCaret === 0) newCaret = 0;

    el.selectionStart = el.selectionEnd = newCaret;

    lastActiveInput = satsInput;
    debouncedConvertFromSats();
}

/**
 * Sanitises the EUR field: strips non-numeric/non-dot chars, enforces a
 * single decimal point, and caps fractional digits at MAX_EUR_DP.
 */
function handleEurInput() {
    if (isProgrammaticUpdate) return;

    const el = eurInput;
    const raw = el.value;
    const caret = el.selectionStart;

    let cleaned = raw.replace(/[^\d.]/g, "");
    const dotIdx = cleaned.indexOf(".");

    if (dotIdx !== -1) {
        cleaned = cleaned.slice(0, dotIdx + 1)
            + cleaned.slice(dotIdx + 1).replace(/\./g, "");

        const parts = cleaned.split(".");
        if (parts[1] && parts[1].length > MAX_EUR_DP) {
            parts[1] = parts[1].slice(0, MAX_EUR_DP);
            cleaned = parts[0] + "." + parts[1];
        }
    }

    const formatted = formatEurString(cleaned);
    const removedBeforeCaret = countRemovedChars(raw, formatted, caret);
    let newCaret = Math.max(0, caret - removedBeforeCaret);

    if (el.value !== formatted) el.value = formatted;
    el.selectionStart = el.selectionEnd = newCaret;

    lastActiveInput = eurInput;
    debouncedConvertFromEur();
}

/**
 * Returns the number of characters stripped from `original[0..caretPos)`
 * during sanitisation, so we can shift the caret left by that amount.
 */
function countRemovedChars(original, cleaned, caretPos) {
    const before = original.slice(0, caretPos);
    let cleanedBefore = before.replace(/[^\d.]/g, "");

    const firstDot = cleanedBefore.indexOf(".");
    if (firstDot !== -1) {
        cleanedBefore = cleanedBefore.slice(0, firstDot + 1)
            + cleanedBefore.slice(firstDot + 1).replace(/\./g, "");
    }
    return before.length - cleanedBefore.length;
}

satsInput.addEventListener("input", handleSatsInput);
eurInput.addEventListener("input", handleEurInput);


// ---------------------------------------------------------------------------
//  Conversion
// ---------------------------------------------------------------------------

function convertFromSats() {
    const raw = parseSatsDisplay(satsInput.value);

    if (isNaN(raw) || raw < 0) { setFieldValue(eurInput, ""); return; }
    if (btcToEurRate === null) return;

    const euros = (raw / SATS_PER_BTC) * btcToEurRate;
    setFieldValue(eurInput, euros.toFixed(MAX_EUR_DP));
}

function convertFromEur() {
    const raw = parseEurDisplay(eurInput.value);

    if (isNaN(raw) || raw < 0) { setFieldValue(satsInput, ""); return; }
    if (btcToEurRate === null) return;

    const sats = Math.round((raw / btcToEurRate) * SATS_PER_BTC);
    setFieldValue(satsInput, formatSatsString(String(sats)));
}

/** Sets a field's value without triggering its formatting handler. */
function setFieldValue(inputEl, value) {
    isProgrammaticUpdate = true;
    inputEl.value = value;
    isProgrammaticUpdate = false;
}

function reconvert() {
    if (lastActiveInput === satsInput) convertFromSats();
    else convertFromEur();
}

const debouncedConvertFromSats = debounce(convertFromSats, DEBOUNCE_MS);
const debouncedConvertFromEur = debounce(convertFromEur, DEBOUNCE_MS);


// ---------------------------------------------------------------------------
//  API
// ---------------------------------------------------------------------------

async function fetchRate() {
    setStatus("Fetching rate…", "");

    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

        const data = await response.json();
        btcToEurRate = data?.bitcoin?.eur;

        if (typeof btcToEurRate !== "number" || btcToEurRate <= 0) {
            throw new Error("Invalid rate data received.");
        }

        rateDisplay.textContent = `1 BTC = ${fmtRate.format(btcToEurRate)}`;
        setStatus(`Updated ${new Date().toLocaleTimeString("it-IT")}`, "success");
        reconvert();
    } catch (err) {
        console.error("[SatsEuro] Rate fetch failed:", err);
        setStatus(`Update failed — ${err.message}`, "error");

        if (btcToEurRate === null) rateDisplay.textContent = "Rate unavailable";
    }
}


// ---------------------------------------------------------------------------
//  Status helper
// ---------------------------------------------------------------------------

function setStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = "converter__status";

    if (type === "error") statusMessage.classList.add("converter__status--error");
    if (type === "success") statusMessage.classList.add("converter__status--success");
}


// ---------------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------------

document.querySelector(".converter__form")?.addEventListener("submit", (e) => e.preventDefault());

(async function init() {
    await fetchRate();
    refreshTimer = setInterval(fetchRate, REFRESH_MS);
})();
