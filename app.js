(function () {
  "use strict";

  const STORAGE_KEY = "minimal-pomodoro-state-v1";
  const modes = {
    focus: {
      label: "Focus",
      durationKey: "focusMinutes",
      nextLabel: "short break",
      completeTitle: "Focus complete",
      completeMessage: "Time for a break."
    },
    short: {
      label: "Short break",
      durationKey: "shortMinutes",
      nextLabel: "focus",
      completeTitle: "Break complete",
      completeMessage: "Ready for another focus session."
    },
    long: {
      label: "Long break",
      durationKey: "longMinutes",
      nextLabel: "focus",
      completeTitle: "Long break complete",
      completeMessage: "Come back gently."
    }
  };

  const defaults = {
    mode: "focus",
    remaining: 25 * 60,
    currentDuration: 25 * 60,
    isRunning: false,
    endAt: null,
    completedInCycle: 0,
    todayKey: todayKey(),
    todayFocusSessions: 0,
    todayFocusMinutes: 0,
    task: "",
    settings: {
      focusMinutes: 25,
      shortMinutes: 5,
      longMinutes: 15,
      longEvery: 4,
      autoStart: false,
      sound: true,
      notifications: false
    }
  };

  let state = loadState();
  let tickHandle = null;
  let audioContext = null;
  let wakeLock = null;

  const elements = {
    body: document.body,
    modeTabs: Array.from(document.querySelectorAll(".mode-tab")),
    modeLabel: document.getElementById("modeLabel"),
    timerTime: document.getElementById("timerTime"),
    nextLabel: document.getElementById("nextLabel"),
    statusText: document.getElementById("statusText"),
    startPauseButton: document.getElementById("startPauseButton"),
    resetButton: document.getElementById("resetButton"),
    skipButton: document.getElementById("skipButton"),
    cycleRow: document.querySelector(".session-row"),
    taskInput: document.getElementById("taskInput"),
    todayMetric: document.getElementById("todayMetric"),
    minutesMetric: document.getElementById("minutesMetric"),
    focusMinutes: document.getElementById("focusMinutes"),
    shortMinutes: document.getElementById("shortMinutes"),
    longMinutes: document.getElementById("longMinutes"),
    longEvery: document.getElementById("longEvery"),
    autoStartToggle: document.getElementById("autoStartToggle"),
    soundToggle: document.getElementById("soundToggle"),
    notifyButton: document.getElementById("notifyButton")
  };

  initialise();

  function initialise() {
    rollTodayIfNeeded();
    restoreRunningTimer();
    syncInputs();
    bindEvents();
    render();
    setTicking(state.isRunning);
  }

  function bindEvents() {
    elements.startPauseButton.addEventListener("click", toggleTimer);
    elements.resetButton.addEventListener("click", resetTimer);
    elements.skipButton.addEventListener("click", () => finishMode({ counted: false, automatic: false }));

    elements.modeTabs.forEach((button) => {
      button.addEventListener("click", () => switchMode(button.dataset.mode));
    });

    elements.taskInput.addEventListener("input", () => {
      state.task = elements.taskInput.value.trim();
      saveState();
    });

    [
      elements.focusMinutes,
      elements.shortMinutes,
      elements.longMinutes,
      elements.longEvery
    ].forEach((input) => {
      input.addEventListener("change", () => updateNumberSetting(input));
      input.addEventListener("blur", () => updateNumberSetting(input));
    });

    elements.autoStartToggle.addEventListener("change", () => {
      state.settings.autoStart = elements.autoStartToggle.checked;
      saveState();
    });

    elements.soundToggle.addEventListener("change", () => {
      state.settings.sound = elements.soundToggle.checked;
      saveState();
    });

    elements.notifyButton.addEventListener("click", requestNotifications);

    document.addEventListener("visibilitychange", () => {
      if (state.isRunning) {
        render();
      }
    });

    document.addEventListener("keydown", (event) => {
      const tagName = event.target && event.target.tagName;
      const isTyping = tagName === "INPUT" || tagName === "TEXTAREA";

      if (isTyping) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        toggleTimer();
      } else if (event.key.toLowerCase() === "r") {
        resetTimer();
      } else if (event.key.toLowerCase() === "s") {
        finishMode({ counted: false, automatic: false });
      } else if (event.key === "1") {
        switchMode("focus");
      } else if (event.key === "2") {
        switchMode("short");
      } else if (event.key === "3") {
        switchMode("long");
      }
    });

    window.addEventListener("beforeunload", () => {
      if (state.isRunning) {
        state.remaining = secondsRemaining();
      }
      saveState();
    });
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== "object") {
        return cloneDefaults();
      }

      const merged = {
        ...cloneDefaults(),
        ...saved,
        settings: {
          ...defaults.settings,
          ...(saved.settings || {})
        }
      };

      if (!modes[merged.mode]) {
        merged.mode = defaults.mode;
      }

      normaliseLoadedState(merged);
      return merged;
    } catch {
      return cloneDefaults();
    }
  }

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(defaults));
  }

  function normaliseLoadedState(nextState) {
    nextState.settings.focusMinutes = boundedInteger(nextState.settings.focusMinutes, 1, 180, defaults.settings.focusMinutes);
    nextState.settings.shortMinutes = boundedInteger(nextState.settings.shortMinutes, 1, 90, defaults.settings.shortMinutes);
    nextState.settings.longMinutes = boundedInteger(nextState.settings.longMinutes, 1, 120, defaults.settings.longMinutes);
    nextState.settings.longEvery = boundedInteger(nextState.settings.longEvery, 2, 12, defaults.settings.longEvery);
    nextState.completedInCycle = boundedInteger(nextState.completedInCycle, 0, nextState.settings.longEvery - 1, 0);
    nextState.todayFocusSessions = boundedInteger(nextState.todayFocusSessions, 0, 10000, 0);
    nextState.todayFocusMinutes = boundedInteger(nextState.todayFocusMinutes, 0, 100000, 0);

    if (!Number.isFinite(Number(nextState.currentDuration)) || Number(nextState.currentDuration) <= 0) {
      nextState.currentDuration = durationFor(nextState.mode, nextState.settings);
    }

    if (!Number.isFinite(Number(nextState.remaining)) || Number(nextState.remaining) < 0) {
      nextState.remaining = nextState.currentDuration;
    }
  }

  function boundedInteger(value, min, max, fallback) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function rollTodayIfNeeded() {
    const currentKey = todayKey();
    if (state.todayKey !== currentKey) {
      state.todayKey = currentKey;
      state.todayFocusSessions = 0;
      state.todayFocusMinutes = 0;
      saveState();
    }
  }

  function restoreRunningTimer() {
    if (!state.isRunning || !state.endAt) {
      state.isRunning = false;
      state.endAt = null;
      state.currentDuration = state.currentDuration || modeDuration(state.mode);
      state.remaining = clampRemaining(state.remaining || modeDuration(state.mode));
      return;
    }

    const remaining = Math.ceil((state.endAt - Date.now()) / 1000);
    if (remaining > 0) {
      state.remaining = remaining;
      return;
    }

    state.isRunning = false;
    state.endAt = null;
    state.remaining = 0;
    state.currentDuration = state.currentDuration || modeDuration(state.mode);
  }

  function syncInputs() {
    elements.focusMinutes.value = state.settings.focusMinutes;
    elements.shortMinutes.value = state.settings.shortMinutes;
    elements.longMinutes.value = state.settings.longMinutes;
    elements.longEvery.value = state.settings.longEvery;
    elements.autoStartToggle.checked = state.settings.autoStart;
    elements.soundToggle.checked = state.settings.sound;
    elements.taskInput.value = state.task || "";
    updateNotificationButton();
  }

  function toggleTimer() {
    if (state.isRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  function startTimer() {
    if (state.remaining <= 0) {
      state.currentDuration = modeDuration(state.mode);
      state.remaining = state.currentDuration;
    }

    state.currentDuration = state.currentDuration || modeDuration(state.mode);
    unlockAudio();
    state.isRunning = true;
    state.endAt = Date.now() + state.remaining * 1000;
    setTicking(true);
    requestWakeLock();
    saveState();
    render();
  }

  function pauseTimer() {
    state.remaining = secondsRemaining();
    state.isRunning = false;
    state.endAt = null;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  function resetTimer() {
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(state.mode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  function switchMode(nextMode) {
    if (!modes[nextMode] || nextMode === state.mode) {
      return;
    }

    state.mode = nextMode;
    state.isRunning = false;
    state.endAt = null;
    state.currentDuration = modeDuration(nextMode);
    state.remaining = state.currentDuration;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();
  }

  function finishMode({ counted, automatic }) {
    const completedMode = state.mode;
    const shouldCountFocus = counted && completedMode === "focus";

    if (shouldCountFocus) {
      rollTodayIfNeeded();
      state.completedInCycle = (state.completedInCycle + 1) % state.settings.longEvery;
      state.todayFocusSessions += 1;
      state.todayFocusMinutes += Math.round((state.currentDuration || modeDuration("focus")) / 60);
    }

    const nextMode = getNextMode(completedMode, shouldCountFocus);
    state.mode = nextMode;
    state.currentDuration = modeDuration(nextMode);
    state.remaining = state.currentDuration;
    state.isRunning = false;
    state.endAt = null;
    setTicking(false);
    releaseWakeLock();
    saveState();
    render();

    if (automatic) {
      announceCompletion(completedMode);
    }

    if (automatic && state.settings.autoStart) {
      window.setTimeout(startTimer, 700);
    }
  }

  function getNextMode(completedMode, countedFocus) {
    if (completedMode !== "focus") {
      return "focus";
    }

    if (!countedFocus) {
      return state.completedInCycle === state.settings.longEvery - 1 ? "long" : "short";
    }

    return state.completedInCycle === 0 ? "long" : "short";
  }

  function setTicking(shouldTick) {
    window.clearInterval(tickHandle);
    tickHandle = null;

    if (!shouldTick) {
      return;
    }

    tickHandle = window.setInterval(() => {
      const remaining = secondsRemaining();
      state.remaining = remaining;

      if (remaining <= 0) {
        finishMode({ counted: true, automatic: true });
        return;
      }

      render();
    }, 250);
  }

  function secondsRemaining() {
    if (!state.isRunning || !state.endAt) {
      return clampRemaining(state.remaining);
    }

    return Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
  }

  function modeDuration(mode) {
    return durationFor(mode, state.settings);
  }

  function durationFor(mode, settings) {
    return Math.round(Number(settings[modes[mode].durationKey]) * 60);
  }

  function clampRemaining(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      return modeDuration(state.mode);
    }
    return Math.round(number);
  }

  function updateNumberSetting(input) {
    const min = Number(input.min || 1);
    const max = Number(input.max || 180);
    const value = Math.min(max, Math.max(min, Math.round(Number(input.value) || min)));
    input.value = value;
    state.settings[input.id] = value;

    if (input.id === "longEvery") {
      state.completedInCycle = Math.min(state.completedInCycle, value - 1);
    }

    if (!state.isRunning && modes[state.mode].durationKey === input.id) {
      state.currentDuration = modeDuration(state.mode);
      state.remaining = state.currentDuration;
    }

    saveState();
    render();
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      setTransientStatus("Unsupported");
      state.settings.notifications = false;
      saveState();
      updateNotificationButton();
      return;
    }

    try {
      const permissionResult = Notification.requestPermission();
      const permission = permissionResult && typeof permissionResult.then === "function"
        ? await permissionResult
        : Notification.permission;
      state.settings.notifications = permission === "granted";
      setTransientStatus(permission === "granted" ? "Notifications on" : "Notifications off");
      saveState();
      updateNotificationButton();
    } catch {
      setTransientStatus("Notifications off");
    }
  }

  function updateNotificationButton() {
    if (!("Notification" in window)) {
      elements.notifyButton.textContent = "Notifications unavailable";
      elements.notifyButton.disabled = true;
      return;
    }

    if (Notification.permission === "granted" && state.settings.notifications) {
      elements.notifyButton.textContent = "Notifications enabled";
    } else if (Notification.permission === "denied") {
      elements.notifyButton.textContent = "Notifications blocked";
    } else {
      elements.notifyButton.textContent = "Enable notifications";
    }
  }

  function announceCompletion(completedMode) {
    const mode = modes[completedMode];

    if (state.settings.sound) {
      playChime();
    }

    if (
      state.settings.notifications &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      const body = state.task ? `${mode.completeMessage} ${state.task}` : mode.completeMessage;
      new Notification(mode.completeTitle, {
        body,
        icon: "assets/app-icon.svg",
        badge: "assets/app-icon.svg"
      });
    }
  }

  function unlockAudio() {
    if (!state.settings.sound || audioContext) {
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  }

  function playChime() {
    unlockAudio();
    if (!audioContext) {
      return;
    }

    const now = audioContext.currentTime;
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
    gain.connect(audioContext.destination);

    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.11);
      oscillator.connect(gain);
      oscillator.start(now + index * 0.11);
      oscillator.stop(now + 0.72);
    });
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) {
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch {
      wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) {
      return;
    }

    try {
      await wakeLock.release();
    } catch {
      wakeLock = null;
    }
  }

  function setTransientStatus(message) {
    elements.statusText.textContent = message;
    window.setTimeout(renderStatus, 1400);
  }

  function render() {
    rollTodayIfNeeded();
    const remaining = secondsRemaining();
    const duration = state.currentDuration || modeDuration(state.mode);
    const elapsed = Math.max(0, duration - remaining);
    const progress = duration > 0 ? Math.min(1, elapsed / duration) : 0;
    const mode = modes[state.mode];

    elements.body.dataset.mode = state.mode;
    elements.body.classList.toggle("is-running", state.isRunning);
    document.documentElement.style.setProperty("--progress", progress.toFixed(4));
    document.title = `${formatTime(remaining)} - ${mode.label}`;

    elements.modeLabel.textContent = mode.label;
    elements.timerTime.textContent = formatTime(remaining);
    elements.nextLabel.textContent = `Next: ${nextModeLabel()}`;
    elements.startPauseButton.textContent = state.isRunning ? "Pause" : "Start";

    elements.modeTabs.forEach((button) => {
      const isActive = button.dataset.mode === state.mode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });

    renderCycleDots();
    Array.from(elements.cycleRow.children).forEach((dot, index) => {
      dot.classList.toggle("is-done", index < state.completedInCycle);
      dot.classList.toggle("is-current", index === state.completedInCycle);
    });

    elements.todayMetric.textContent = pluralise(state.todayFocusSessions, "focus session");
    elements.minutesMetric.textContent = `${state.todayFocusMinutes} min`;
    renderStatus();
  }

  function renderCycleDots() {
    const needed = state.settings.longEvery;
    if (elements.cycleRow.children.length === needed) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < needed; index += 1) {
      const dot = document.createElement("span");
      dot.className = "cycle-dot";
      fragment.appendChild(dot);
    }
    elements.cycleRow.replaceChildren(fragment);
  }

  function renderStatus() {
    elements.statusText.textContent = state.isRunning ? "Running" : "Ready";
  }

  function nextModeLabel() {
    if (state.mode !== "focus") {
      return "focus";
    }

    return state.completedInCycle === state.settings.longEvery - 1 ? "long break" : "short break";
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function pluralise(count, noun) {
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  }

  function todayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
})();
