"use strict";

/**
 * Guards the question bank in CI. Catches the mistakes that are easy to make
 * when adding questions by hand and annoying to find during a party.
 */

const path = require("path");
const bank = require(path.join(__dirname, "..", "api", "shared", "bank.json"));

const ERAS = ["80s", "90s", "00s", "10s", "20s"];
const DIFFS = ["easy", "medium", "hard"];

const problems = [];
const seenIds = new Set();
const seenPrompts = new Set();

bank.questions.forEach((q, i) => {
  const where = `#${i + 1} (${q.id || "no id"})`;

  if (!q.id) problems.push(`${where}: missing id`);
  else if (seenIds.has(q.id)) problems.push(`${where}: duplicate id`);
  else seenIds.add(q.id);

  if (!q.prompt) problems.push(`${where}: missing prompt`);
  else {
    const key = q.prompt.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenPrompts.has(key)) problems.push(`${where}: duplicate prompt`);
    else seenPrompts.add(key);
  }

  if (!q.answer) problems.push(`${where}: missing answer`);
  if (!Array.isArray(q.wrong) || q.wrong.length !== 3) {
    problems.push(`${where}: needs exactly 3 wrong answers, found ${q.wrong ? q.wrong.length : 0}`);
  }

  const choices = [q.answer].concat(q.wrong || []);
  const lowered = choices.map((c) => String(c).toLowerCase().trim());
  if (new Set(lowered).size !== lowered.length) {
    problems.push(`${where}: two choices are the same`);
  }
  if (choices.some((c) => !String(c).trim())) problems.push(`${where}: a choice is blank`);

  if (!ERAS.includes(q.era)) problems.push(`${where}: era "${q.era}" is not one of ${ERAS.join(", ")}`);
  if (!DIFFS.includes(q.difficulty)) problems.push(`${where}: difficulty "${q.difficulty}" is not one of ${DIFFS.join(", ")}`);
  if (!q.song) problems.push(`${where}: missing song`);
  if (!q.artist) problems.push(`${where}: missing artist`);
  if (!(q.year >= 1985 && q.year <= new Date().getFullYear())) {
    problems.push(`${where}: year ${q.year} is outside 1985..now`);
  }
});

// a round deals round-robin, so a thin era caps how long an all-eras round can be
const perEra = {};
ERAS.forEach((e) => { perEra[e] = bank.questions.filter((q) => q.era === e).length; });
const thinnest = Math.min(...ERAS.map((e) => perEra[e]));

console.log(`bank v${bank.version}: ${bank.questions.length} questions`);
console.log(ERAS.map((e) => `${e}=${perEra[e]}`).join("  "));

if (thinnest < 5) {
  problems.push(`thinnest era has only ${thinnest} questions; a 20-question round needs 4 per era`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  problems.forEach((p) => console.error(`  - ${p}`));
  process.exit(1);
}

console.log("bank looks good");
