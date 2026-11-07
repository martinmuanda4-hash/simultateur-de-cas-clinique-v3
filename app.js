"use strict";

/*
 * Cas Zéro – clinical case simulator.
 * All logic and state is in English. All text shown to the student
 * comes from data/cas-zero-medecine-interne.json (French).
 */

const DATA_URL = "data/cas-zero-medecine-interne.json";
const STORAGE_KEY = "cas-zero-best-score";
const MAX_SCORE = 100;
const HINT_PENALTY = 2;
const DIAGNOSIS_ATTEMPTS_BEFORE_REVEAL = 3;

const STEP_KEYS = [
  "etape1_anamnese",
  "etape2_examen_physique",
  "etape3_paraclinique",
  "etape4_diagnostic",
  "etape5_traitement",
  "etape6_debriefing"
];

const state = {
  caseData: null, // full French JSON
  ui: null,       // caseData.interface
  score: 0,
  stepIndex: -1,
  bestScore: 0
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function $(selector) {
  return document.querySelector(selector);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Lowercase, strip accents/punctuation so "Céphalées" matches "cepha". */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Position of a keyword inside normalized text, or -1.
 * Short keywords (<= 3 chars, e.g. "pl", "ge") must match a whole word
 * so "pl" does not match "plasmodium".
 */
function findKeyword(normalizedText, keyword) {
  const key = normalize(keyword);
  if (!key) return -1;
  if (key.length <= 3) {
    const match = new RegExp("(^| )" + key + "( |$)").exec(normalizedText);
    return match ? match.index + match[1].length : -1;
  }
  return normalizedText.indexOf(key);
}

function hasKeyword(text, keywords) {
  const normalized = normalize(text);
  return keywords.some((keyword) => findKeyword(normalized, keyword) !== -1);
}

/** True if a negation ("pas de", "sans", "éviter"...) comes right before the keyword. */
function isNegated(normalizedText, index) {
  const before = normalizedText.slice(Math.max(0, index - 30), index);
  return /(^| )(pas|sans|eviter|jamais|non|interdit|contre indique)( |$)/.test(before);
}

/** Fatal keyword present and not negated. */
function containsFatalKeyword(text, keywords) {
  const normalized = normalize(text);
  return keywords.some((keyword) => {
    const index = findKeyword(normalized, keyword);
    return index !== -1 && !isNegated(normalized, index);
  });
}

function splitSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+/g);
  return (parts || [text]).map((part) => part.trim());
}

function formatVitalValue(value) {
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Score                                                              */
/* ------------------------------------------------------------------ */

function changeScore(delta) {
  const previous = state.score;
  state.score = Math.max(0, Math.min(MAX_SCORE, previous + delta));
  const applied = state.score - previous;
  renderScore();
  if (applied !== 0) showToast(applied);
}

function renderScore() {
  $("#scoreValue").textContent = String(state.score);
  const box = $("#score");
  box.classList.remove("low", "critical");
  if (state.score < 40) box.classList.add("critical");
  else if (state.score < 70) box.classList.add("low");
  box.classList.remove("bump");
  void box.offsetWidth; // restart animation
  box.classList.add("bump");
}

function showToast(applied) {
  const toast = el("div", "toast " + (applied > 0 ? "plus" : "minus"),
    (applied > 0 ? "+" : "") + applied);
  $("#toastLayer").append(toast);
  setTimeout(() => toast.remove(), 1700);
}

/* ------------------------------------------------------------------ */
/* Top bar                                                            */
/* ------------------------------------------------------------------ */

function buildTracker() {
  const tracker = $("#tracker");
  tracker.innerHTML = "";
  state.ui.etapesCourtes.forEach((name, index) => {
    const item = el("li");
    item.append(el("span", "dot", String(index + 1)), el("span", "name", name));
    tracker.append(item);
  });
  $("#scoreLabel").textContent = state.ui.labelScore;
}

function renderTracker() {
  const items = $("#tracker").children;
  Array.from(items).forEach((item, index) => {
    item.classList.toggle("done", index < state.stepIndex);
    item.classList.toggle("current", index === state.stepIndex);
  });
  const progress = Math.max(0, state.stepIndex) / (STEP_KEYS.length - 1);
  $("#progressFill").style.width = Math.round(progress * 100) + "%";
  const currentName = $("#currentName");
  if (currentName) currentName.textContent = state.ui.etapesCourtes[state.stepIndex] || "";
}

/* ------------------------------------------------------------------ */
/* Vital signs monitor (always visible: ECG trace + live values)      */
/* ------------------------------------------------------------------ */

const MONITOR_REFRESH_MS = 2000;
const ECG_SWEEP_SPEED = 90;   // pixels per second
const ECG_ERASE_GAP = 14;     // pixels erased ahead of the moving trace
const ALARM_DURATION_MS = 3500;
const MAX_SPO2 = 100;
const ECG_COLOR = "#22c55e";

// Maximum drift (+/-) around the case values, one entry per parsed number.
const VITAL_DRIFT = {
  frequenceCardiaque: [3],
  tension: [4, 3],
  saturation: [1],
  frequenceRespiratoire: [1],
  glycemieCapillaire: [0] // capillary glucose is a spot measurement: it stays fixed
};

const VITAL_COLORS = {
  frequenceCardiaque: "#22c55e",
  tension: "#f87171",
  saturation: "#38bdf8",
  frequenceRespiratoire: "#facc15",
  glycemieCapillaire: "#c084fc"
};

const monitor = {
  built: false,
  running: false,
  vitals: {},   // key -> { base: number[], current: number[] }
  fields: {},   // key -> value element
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  x: 0,
  prevY: 0,
  beatPhase: 0,
  lastFrame: 0,
  refreshTimer: null,
  alarmTimer: null
};

function parseVitalNumbers(text) {
  const found = String(text).match(/\d+(?:[.,]\d+)?/g) || [];
  return found.map((value) => parseFloat(value.replace(",", ".")));
}

function buildMonitor() {
  const config = state.ui.moniteur;
  const constants = state.caseData.etapes.etape2_examen_physique.constantes;
  const root = $("#monitor");
  root.innerHTML = "";
  root.setAttribute("aria-label", config.titre);

  const inner = el("div", "monitor-inner");
  const ecgBox = el("div", "monitor-ecg");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  ecgBox.append(canvas);

  const values = el("div", "monitor-values");
  monitor.vitals = {};
  monitor.fields = {};
  config.ordre.forEach((key) => {
    const numbers = parseVitalNumbers(constants[key]);
    if (numbers.length === 0) return;
    monitor.vitals[key] = { base: numbers, current: numbers.slice() };

    const cell = el("div", "monitor-cell");
    cell.style.setProperty("--vital-color", VITAL_COLORS[key] || "#e5e7eb");
    const value = el("span", "monitor-value");
    cell.append(
      el("span", "monitor-label", config.libelles[key] || key),
      value,
      el("span", "monitor-unit", config.unites[key] || "")
    );
    monitor.fields[key] = value;
    values.append(cell);
  });

  inner.append(ecgBox, values);
  root.append(inner);
  monitor.canvas = canvas;
  monitor.ctx = canvas.getContext("2d");
  monitor.built = true;
  renderMonitorValues();
  window.addEventListener("resize", resizeEcg);
}

function renderMonitorValues() {
  Object.keys(monitor.vitals).forEach((key) => {
    monitor.fields[key].textContent = monitor.vitals[key].current.join("/");
  });
}

/** Small random walk around the case values so the monitor feels alive. */
function refreshVitals() {
  Object.keys(monitor.vitals).forEach((key) => {
    const vital = monitor.vitals[key];
    const drift = VITAL_DRIFT[key] || [0];
    vital.current = vital.current.map((value, index) => {
      const limit = drift[index] || 0;
      if (!limit) return value;
      const step = Math.floor(Math.random() * 3) - 1;
      let next = Math.max(vital.base[index] - limit, Math.min(vital.base[index] + limit, value + step));
      if (key === "saturation") next = Math.min(next, MAX_SPO2);
      return next;
    });
  });
  renderMonitorValues();
}

function resizeEcg() {
  const canvas = monitor.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  monitor.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  monitor.width = rect.width;
  monitor.height = rect.height;
  monitor.x = 0;
  monitor.prevY = rect.height * 0.72;
}

function gaussian(x, center, width) {
  const delta = x - center;
  return Math.exp(-(delta * delta) / (2 * width * width));
}

/** Synthetic P-QRS-T shape for a beat phase between 0 and 1 (R peak = 1). */
function ecgSample(phase) {
  return 0.12 * gaussian(phase, 0.16, 0.025)
    - 0.15 * gaussian(phase, 0.285, 0.009)
    + 1.0 * gaussian(phase, 0.31, 0.011)
    - 0.28 * gaussian(phase, 0.34, 0.011)
    + 0.3 * gaussian(phase, 0.58, 0.05);
}

function pulseHeartRate() {
  const field = monitor.fields.frequenceCardiaque;
  if (!field) return;
  field.classList.remove("beat");
  void field.offsetWidth; // restart animation
  field.classList.add("beat");
}

function drawEcg(dt) {
  const ctx = monitor.ctx;
  const width = monitor.width;
  const height = monitor.height;
  const heartRate = monitor.vitals.frequenceCardiaque ? monitor.vitals.frequenceCardiaque.current[0] : 80;
  const beatPeriod = 60 / heartRate;
  const steps = Math.max(1, Math.round(dt * ECG_SWEEP_SPEED));
  const phaseStep = (dt / steps) / beatPeriod;
  const baseline = height * 0.72;
  const amplitude = height * 0.62;

  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = ECG_COLOR;

  for (let i = 0; i < steps; i += 1) {
    monitor.beatPhase += phaseStep;
    if (monitor.beatPhase >= 1) {
      monitor.beatPhase -= 1;
      pulseHeartRate();
    }
    const y = baseline - ecgSample(monitor.beatPhase) * amplitude;
    const nextX = monitor.x + 1;
    if (nextX >= width) {
      monitor.x = 0;
      monitor.prevY = y;
      ctx.clearRect(0, 0, ECG_ERASE_GAP, height);
      continue;
    }
    ctx.clearRect(nextX, 0, ECG_ERASE_GAP, height);
    ctx.beginPath();
    ctx.moveTo(monitor.x, monitor.prevY);
    ctx.lineTo(nextX, y);
    ctx.stroke();
    monitor.x = nextX;
    monitor.prevY = y;
  }
}

function ecgFrame(now) {
  if (!monitor.running) return;
  const dt = Math.min(Math.max((now - monitor.lastFrame) / 1000, 0), 0.1);
  monitor.lastFrame = now;
  if (monitor.ctx && monitor.width > 0 && dt > 0) drawEcg(dt);
  requestAnimationFrame(ecgFrame);
}

function startMonitor() {
  if (!monitor.built || monitor.running) return;
  $("#monitor").hidden = false;
  resizeEcg();
  monitor.running = true;
  monitor.lastFrame = performance.now();
  monitor.refreshTimer = setInterval(refreshVitals, MONITOR_REFRESH_MS);
  requestAnimationFrame(ecgFrame);
}

function flashMonitorAlarm() {
  const root = $("#monitor");
  root.classList.add("alarm");
  clearTimeout(monitor.alarmTimer);
  monitor.alarmTimer = setTimeout(() => root.classList.remove("alarm"), ALARM_DURATION_MS);
}

/* ------------------------------------------------------------------ */
/* Step shell (card + chat + form + buttons)                          */
/* ------------------------------------------------------------------ */

function createShell(step, options) {
  const ui = state.ui;
  const stage = $("#stage");
  stage.innerHTML = "";

  const card = el("section", "card step-card enter");
  const head = el("div", "step-head");
  head.append(
    el("span", "step-chip", (state.stepIndex + 1) + "/" + STEP_KEYS.length),
    el("h1", "step-title", step.titre)
  );
  card.append(head);
  if (options.instruction) card.append(el("p", "instruction", options.instruction));

  const chat = el("div", "chat");
  card.append(chat);

  const shell = {
    card,
    chat,
    onSubmit: null,
    onNext: null,
    helpUsed: false,
    nextButton: null,
    actions: null
  };

  shell.addMessage = (kind, text, title) => {
    const bubble = el("div", "msg msg-" + kind);
    if (title) bubble.append(el("span", "msg-title", title));
    bubble.append(document.createTextNode(text));
    chat.append(bubble);
    bubble.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (kind === "danger") {
      card.classList.remove("shake");
      void card.offsetWidth;
      card.classList.add("shake");
    }
    return bubble;
  };

  shell.addBlock = (node) => {
    chat.append(node);
    return node;
  };

  if (options.withForm !== false) {
    const form = el("form", "form");
    form.setAttribute("autocomplete", "off");
    const input = el("input", "input");
    input.type = "text";
    input.placeholder = options.placeholder || "";
    input.setAttribute("aria-label", options.placeholder || "");
    const send = el("button", "btn btn-blue", ui.boutonEnvoyer);
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || !shell.onSubmit) return;
      input.value = "";
      shell.onSubmit(value);
    });
    card.append(form);
    shell.input = input;
  }

  const actions = el("div", "actions");
  shell.actions = actions;

  if (step.aide) {
    const help = el("button", "btn btn-ghost", ui.boutonAide);
    help.type = "button";
    help.append(el("span", "penalty", "-" + HINT_PENALTY));
    help.addEventListener("click", () => {
      if (shell.helpUsed) return;
      shell.helpUsed = true;
      changeScore(-HINT_PENALTY);
      shell.addMessage("hint", step.aide, ui.libellesMessages.indice);
      shell.addMessage("warn", ui.messages.aideUtilisee);
      help.disabled = true;
    });
    actions.append(help);
  }

  const next = el("button", "btn btn-primary", ui.boutonContinuer);
  next.type = "button";
  next.hidden = true;
  next.addEventListener("click", () => {
    if (!shell.onNext || shell.onNext() !== false) goToStep(state.stepIndex + 1);
  });
  actions.append(next);
  shell.nextButton = next;
  shell.showNext = () => { next.hidden = false; };

  card.append(actions);
  stage.append(card);
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (shell.input) shell.input.focus({ preventScroll: true });
  return shell;
}

function createBlock(title, text, className) {
  const block = el("div", "block" + (className ? " " + className : ""));
  block.append(el("h3", null, title));
  if (text !== undefined) block.append(el("p", null, text));
  return block;
}

/* ------------------------------------------------------------------ */
/* Step 1 – history taking                                            */
/* ------------------------------------------------------------------ */

function renderAnamnesis(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: ui.consignes.etape1_anamnese,
    placeholder: ui.placeholders.etape1_anamnese
  });

  const sentences = splitSentences(step.reponsesAttendues.revelationProgressive);
  const chunkSize = 2;
  let revealedCount = 0;

  shell.addMessage("sim", step.presentationInitiale, ui.libellesMessages.famille);

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    if (revealedCount >= sentences.length) {
      shell.addMessage("good", ui.messages.toutRevele);
      return;
    }
    if (hasKeyword(text, step.reponsesAttendues.motsCles)) {
      const chunk = sentences.slice(revealedCount, revealedCount + chunkSize);
      revealedCount += chunk.length;
      shell.addMessage("sim", chunk.join(" "), ui.libellesMessages.famille);
      if (revealedCount >= sentences.length) {
        shell.addMessage("good", ui.messages.toutRevele);
        shell.showNext();
      }
    } else {
      shell.addMessage("warn", ui.messages.questionNonReconnue);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 – physical exam                                             */
/* ------------------------------------------------------------------ */

function renderPhysicalExam(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: ui.consignes.etape2_examen_physique,
    placeholder: ui.placeholders.etape2_examen_physique
  });

  // Vital signs
  const vitalsBlock = createBlock(ui.libellesBlocs.constantes);
  const grid = el("div", "vitals");
  Object.entries(step.constantes).forEach(([key, value]) => {
    const cell = el("div", "vital");
    cell.append(
      el("span", "k", ui.libellesConstantes[key] || key),
      el("span", "v", formatVitalValue(value))
    );
    grid.append(cell);
  });
  vitalsBlock.append(grid);
  shell.addBlock(vitalsBlock);

  shell.addBlock(createBlock(ui.libellesBlocs.examenGeneral, step.examenGeneral));
  shell.addBlock(createBlock(ui.libellesBlocs.examenSystemes, step.examenSystemes));

  const neuro = step.examenNeurologique;
  const neuroBlock = createBlock(ui.libellesBlocs.examenNeurologique, ui.libellesBlocs.nonRealise, "locked");
  shell.addBlock(neuroBlock);
  let neuroDone = false;

  function revealNeuro() {
    neuroDone = true;
    neuroBlock.classList.remove("locked");
    neuroBlock.classList.add("revealed");
    neuroBlock.querySelector("p").textContent = neuro.resultats;
    neuroBlock.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    if (hasKeyword(text, neuro.demandeRequise)) {
      if (neuroDone) {
        shell.addMessage("warn", ui.messages.examenDejaFait);
      } else {
        revealNeuro();
        shell.addMessage("good", ui.messages.examenNeuroDemande);
        shell.showNext();
      }
    } else {
      shell.addMessage("warn", ui.messages.examenNonReconnu);
    }
  };

  // Leaving without the neurological exam costs points, then reveals it.
  shell.onNext = () => {
    if (neuroDone) return true;
    changeScore(-neuro.malusSiOubli);
    revealNeuro();
    shell.addMessage("danger", ui.messages.examenNeuroOublie);
    return false; // stay one more moment so the student reads the result
  };
  shell.showNext();
}

/* ------------------------------------------------------------------ */
/* Step 3 – paraclinical work-up                                      */
/* ------------------------------------------------------------------ */

function renderParaclinical(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: step.question,
    placeholder: ui.placeholders.etape3_paraclinique
  });

  const exams = Object.entries(step.examensValides);
  const foundExams = new Set();
  const penalizedInputs = new Set();

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    let matchedAny = false;

    exams.forEach(([key, exam]) => {
      if (!hasKeyword(text, exam.motsCles)) return;
      matchedAny = true;
      if (foundExams.has(key)) {
        shell.addMessage("warn", ui.messages.examenDejaFait);
      } else {
        foundExams.add(key);
        shell.addMessage("sim", exam.resultat, ui.libellesExamens[key] || ui.libellesMessages.resultat);
      }
    });

    if (!matchedAny) {
      const normalized = normalize(text);
      if (normalized.length >= 2 && !penalizedInputs.has(normalized)) {
        penalizedInputs.add(normalized);
        changeScore(-step.malusExamenInutile);
        shell.addMessage("danger", ui.messages.examenInutile);
      } else {
        shell.addMessage("warn", ui.messages.examenNonReconnu);
      }
    }

    if (foundExams.size === exams.length) {
      shell.addMessage("good", ui.messages.bilanComplet);
      shell.showNext();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 4 – diagnosis                                                 */
/* ------------------------------------------------------------------ */

function renderDiagnosis(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: step.question,
    placeholder: ui.placeholders.etape4_diagnostic
  });

  const expected = step.diagnosticsAttendus;
  const foundDiagnoses = new Set();
  let failedAttempts = 0;
  let revealButton = null;

  function finish() {
    if (revealButton) revealButton.hidden = true;
    shell.showNext();
  }

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);
    let matchedAny = false;
    let newlyFound = false;

    expected.forEach((diagnosis) => {
      if (!hasKeyword(text, diagnosis.motsCles || [diagnosis.nom])) return;
      matchedAny = true;
      if (foundDiagnoses.has(diagnosis.nom)) {
        shell.addMessage("warn", ui.messages.diagnosticDejaTrouve + " " + diagnosis.nom);
      } else {
        foundDiagnoses.add(diagnosis.nom);
        newlyFound = true;
        changeScore(diagnosis.points);
        shell.addMessage("good", ui.messages.diagnosticTrouve + " " + diagnosis.nom);
      }
    });

    if (!matchedAny) {
      failedAttempts += 1;
      shell.addMessage("warn", ui.messages.diagnosticIncorrect);
      if (failedAttempts >= DIAGNOSIS_ATTEMPTS_BEFORE_REVEAL && !revealButton) {
        revealButton = el("button", "btn btn-ghost", ui.boutonVoirReponse);
        revealButton.type = "button";
        revealButton.addEventListener("click", () => {
          const names = expected.map((diagnosis) => diagnosis.nom).join(", ");
          shell.addMessage("sim", ui.messages.diagnosticsReponse + " " + names);
          finish();
        });
        shell.actions.prepend(revealButton);
      }
    }

    if (newlyFound && foundDiagnoses.size === expected.length) {
      shell.addMessage("good", ui.messages.diagnosticsComplets);
      finish();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 5 – treatment                                                 */
/* ------------------------------------------------------------------ */

function renderTreatment(step) {
  const ui = state.ui;
  const shell = createShell(step, {
    instruction: ui.consignes.etape5_traitement,
    placeholder: ui.placeholders.etape5_traitement
  });

  const groups = step.groupesTraitement;
  const coveredGroups = new Set();
  const fatal = step.erreursFatales;

  shell.onSubmit = (text) => {
    shell.addMessage("student", text);

    // Fatal error always takes priority over correct items in the same answer.
    if (containsFatalKeyword(text, fatal.motsCles)) {
      changeScore(-fatal.punition);
      flashMonitorAlarm();
      shell.addMessage("danger", fatal.message, ui.messages.erreurFataleTitre);
      return;
    }

    let matchedAny = false;
    groups.forEach((group) => {
      if (!hasKeyword(text, group.motsCles)) return;
      matchedAny = true;
      if (!coveredGroups.has(group.libelle)) {
        coveredGroups.add(group.libelle);
        shell.addMessage("good", ui.messages.traitementTrouve + " " + group.libelle);
      }
    });

    if (coveredGroups.size === groups.length) {
      shell.addMessage("good", ui.messages.traitementComplet);
      shell.showNext();
    } else if (matchedAny) {
      shell.addMessage("warn", ui.messages.traitementPartiel);
    } else {
      shell.addMessage("warn", ui.messages.traitementNonReconnu);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Step 6 – debriefing                                                */
/* ------------------------------------------------------------------ */

function saveBestScore() {
  try {
    if (state.score > state.bestScore) {
      state.bestScore = state.score;
      localStorage.setItem(STORAGE_KEY, String(state.bestScore));
    }
  } catch (error) {
    /* storage unavailable: ignore */
  }
}

function loadBestScore() {
  try {
    const stored = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    state.bestScore = Number.isFinite(stored) ? stored : 0;
  } catch (error) {
    state.bestScore = 0;
  }
}

function renderDebrief(step) {
  const ui = state.ui;
  saveBestScore();

  const stage = $("#stage");
  stage.innerHTML = "";
  const card = el("section", "card step-card enter");
  const head = el("div", "step-head");
  head.append(
    el("span", "step-chip", STEP_KEYS.length + "/" + STEP_KEYS.length),
    el("h1", "step-title", step.titre)
  );
  card.append(head);

  const mention = ui.mentions.find((entry) => state.score >= entry.min);
  const final = el("div", "final-score");
  final.append(
    el("div", "label", ui.labelScoreFinal),
    el("div", "big", state.score + "/" + MAX_SCORE),
    el("div", "mention", mention ? mention.texte : "")
  );
  card.append(final);

  const list = el("ul", "points");
  step.pointsCles.forEach((point, index) => {
    const item = el("li", "point");
    item.style.animationDelay = (index * 0.15) + "s";
    const separator = point.indexOf(":");
    if (separator > 0) {
      item.append(el("strong", null, point.slice(0, separator + 1)), document.createTextNode(point.slice(separator + 1)));
    } else {
      item.textContent = point;
    }
    list.append(item);
  });
  card.append(list);

  const actions = el("div", "actions");
  const replay = el("button", "btn btn-primary", ui.boutonRejouer);
  replay.type = "button";
  replay.addEventListener("click", startCase);
  actions.append(replay);
  card.append(actions);

  stage.append(card);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------------ */
/* Navigation                                                         */
/* ------------------------------------------------------------------ */

const STEP_RENDERERS = [
  renderAnamnesis,
  renderPhysicalExam,
  renderParaclinical,
  renderDiagnosis,
  renderTreatment,
  renderDebrief
];

function goToStep(index) {
  state.stepIndex = Math.min(index, STEP_KEYS.length - 1);
  renderTracker();
  const step = state.caseData.etapes[STEP_KEYS[state.stepIndex]];
  STEP_RENDERERS[state.stepIndex](step);
}

function startCase() {
  state.score = state.caseData.scoreInitial;
  $("#topbar").hidden = false;
  renderScore();
  goToStep(0);
}

function renderIntro() {
  const ui = state.ui;
  const data = state.caseData;
  const intro = data.introduction;
  const vitals = data.etapes.etape2_examen_physique.constantes;

  // The top bar (progress, score, monitor) is visible from the very first screen.
  state.score = data.scoreInitial;
  state.stepIndex = -1;
  $("#topbar").hidden = false;
  renderTracker();
  renderScore();
  startMonitor();

  const stage = $("#stage");
  stage.innerHTML = "";
  const card = el("section", "card intro-card enter");
  card.append(
    el("div", "badge", data.specialite),
    el("h1", "intro-title", data.titre),
    el("p", "intro-sub", ui.nomApp + " · " + ui.sousTitre)
  );

  const overview = el("div", "overview");
  overview.append(el("h2", null, intro.titre), el("p", "overview-desc", intro.description));

  const grid = el("div", "overview-grid");
  function addRow(label, valueNode) {
    const value = el("div", "overview-value");
    value.append(valueNode);
    grid.append(el("div", "overview-label", label), value);
  }
  addRow(intro.libelles.lieu, document.createTextNode(intro.lieu));
  addRow(intro.libelles.contexte, document.createTextNode(intro.contexte));
  addRow(intro.libelles.motifConsultation, document.createTextNode(intro.motifConsultation));

  const vitalsList = el("div", "overview-vitals");
  Object.keys(vitals).forEach((key) => {
    vitalsList.append(el("div", null, (ui.libellesConstantes[key] || key) + " : " + vitals[key]));
  });
  addRow(intro.libelles.constantes, vitalsList);
  overview.append(grid);
  card.append(overview);

  const start = el("button", "btn btn-primary btn-block", ui.boutonCommencer);
  start.type = "button";
  start.addEventListener("click", startCase);
  card.append(start);

  if (state.bestScore > 0) {
    card.append(el("div", "best", ui.labelMeilleurScore + " : " + state.bestScore + "/" + MAX_SCORE));
  }
  stage.append(card);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function init() {
  loadBestScore();
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error("HTTP " + response.status);
    state.caseData = await response.json();
    state.ui = state.caseData.interface;
  } catch (error) {
    const card = el("section", "card error-card", "Impossible de charger le cas clinique. Ouvrez l'application depuis un serveur web (Vercel ou npx serve).");
    $("#stage").append(card);
    return;
  }
  document.title = state.ui.nomApp + " – " + state.ui.sousTitre;
  buildTracker();
  buildMonitor();
  renderIntro();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();
