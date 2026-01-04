import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Stage = "load" | "setup" | "play" | "summary";
type Difficulty = "easy" | "normal" | "hard";
type SessionLength = 5 | 10 | 20 | "zen";

type WordEntry = {
  id: string;
  word: string;
  hint?: string;
};

type WordStat = {
  exposures: number;
  correct: number;
  incorrect: number;
  lastSeen: number;
  lastMiss: number;
  mastery: number;
};

type Question = {
  entry: WordEntry;
  choices: WordEntry[];
  correctIndex: number;
  prompt: string;
  example: string;
  mode: "choice" | "type";
};

type SessionState = {
  timeLeft: number;
  energy: number;
  score: number;
  streak: number;
  longestStreak: number;
  combo: number;
  correct: number;
  incorrect: number;
};

type DailyGoal = {
  date: string;
  correct: number;
};

const STAT_KEY = "neonDriftStats_v1";
const DAILY_KEY = "neonDriftDaily_v1";
const DAILY_TARGET = 30;

const SENTENCE_TEMPLATES = [
  "I decided to {word} the plan after reviewing the risks.",
  "She tried to {word} her schedule before the meeting.",
  "They needed to {word} the issue quickly.",
  "We should {word} the details before moving on.",
  "He promised to {word} the task by tonight.",
  "The team chose to {word} the idea with care.",
  "Please {word} the instructions once more.",
  "I had to {word} my response in a hurry.",
  "The coach asked us to {word} the strategy.",
  "They will {word} the results tomorrow.",
];

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const todayKey = () => new Date().toISOString().slice(0, 10);

const loadStats = (): Record<string, WordStat> => {
  const raw = localStorage.getItem(STAT_KEY);
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, WordStat>;
  } catch {
    return {};
  }
};

const saveStats = (stats: Record<string, WordStat>) => {
  localStorage.setItem(STAT_KEY, JSON.stringify(stats));
};

const loadDaily = (): DailyGoal => {
  const raw = localStorage.getItem(DAILY_KEY);
  if (!raw) {
    return { date: todayKey(), correct: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as DailyGoal;
    if (parsed.date !== todayKey()) {
      return { date: todayKey(), correct: 0 };
    }
    return parsed;
  } catch {
    return { date: todayKey(), correct: 0 };
  }
};

const saveDaily = (daily: DailyGoal) => {
  localStorage.setItem(DAILY_KEY, JSON.stringify(daily));
};

const hashWord = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const sentenceFor = (word: string) => {
  const index = hashWord(word) % SENTENCE_TEMPLATES.length;
  const template = SENTENCE_TEMPLATES[index];
  const full = template.replace("{word}", word);
  const cloze = template.replace("{word}", "____");
  return { full, cloze };
};

const parseLines = (
  rawText: string,
  removeEmpty: boolean,
  removeDuplicates: boolean
) => {
  if (!rawText.trim()) {
    return {
      entries: [],
      emptyCount: 0,
      duplicateCount: 0,
      totalLines: 0,
    };
  }
  const lines = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  let emptyCount = 0;
  let duplicateCount = 0;
  const seen = new Set<string>();
  const entries: WordEntry[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      emptyCount += 1;
      if (removeEmpty) {
        return;
      }
    }
    const [wordPart, ...hintParts] = trimmed.split(" - ");
    const word = wordPart.trim();
    if (!word) {
      return;
    }
    const key = word.toLowerCase();
    if (removeDuplicates && seen.has(key)) {
      duplicateCount += 1;
      return;
    }
    seen.add(key);
    const hint = hintParts.join(" - ").trim();
    entries.push({
      id: `${key}-${index}`,
      word,
      hint: hint || undefined,
    });
  });

  return {
    entries,
    emptyCount,
    duplicateCount,
    totalLines: lines.length,
  };
};

const ensureStats = (stats: Record<string, WordStat>, entry: WordEntry) => {
  if (!stats[entry.word]) {
    stats[entry.word] = {
      exposures: 0,
      correct: 0,
      incorrect: 0,
      lastSeen: 0,
      lastMiss: 0,
      mastery: 0.4,
    };
  }
};

const pickWeighted = (
  entries: WordEntry[],
  stats: Record<string, WordStat>,
  lastWord?: string
) => {
  const now = Date.now();
  let total = 0;
  const weights = entries.map((entry) => {
    ensureStats(stats, entry);
    const stat = stats[entry.word];
    const recencyPenalty = entry.word === lastWord ? 0.5 : 1;
    const weak = 1 - stat.mastery;
    const newBonus = stat.exposures === 0 ? 0.6 : 0;
    const recentMiss = now - stat.lastMiss < 36 * 60 * 60 * 1000 ? 0.5 : 0;
    const weight = (0.2 + weak * 0.9 + newBonus + recentMiss) * recencyPenalty;
    total += weight;
    return weight;
  });

  let roll = Math.random() * total;
  for (let i = 0; i < entries.length; i += 1) {
    roll -= weights[i];
    if (roll <= 0) {
      return entries[i];
    }
  }
  return entries[0];
};

const pickChoices = (pool: WordEntry[], correct: WordEntry, size: number) => {
  const choices = [correct];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const entry of shuffled) {
    if (choices.length >= size) {
      break;
    }
    if (entry.word !== correct.word) {
      choices.push(entry);
    }
  }
  return choices.sort(() => Math.random() - 0.5);
};

const mutateWord = (word: string) => {
  const letters = word.split("");
  if (letters.length < 3) {
    return word;
  }
  const roll = Math.floor(Math.random() * 3);
  if (roll === 0) {
    const idx = Math.floor(Math.random() * (letters.length - 1));
    [letters[idx], letters[idx + 1]] = [letters[idx + 1], letters[idx]];
    return letters.join("");
  }
  if (roll === 1) {
    const idx = Math.floor(Math.random() * letters.length);
    letters.splice(idx, 1);
    return letters.join("");
  }
  const idx = Math.floor(Math.random() * letters.length);
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const replacement = alphabet[Math.floor(Math.random() * alphabet.length)];
  letters[idx] = replacement;
  return letters.join("");
};

const similarChoices = (word: string, total: number) => {
  const normalized = word.trim();
  if (normalized.length < 4 || normalized.includes(" ")) {
    return null;
  }
  const variants = new Set<string>();
  let guard = 0;
  while (variants.size < total - 1 && guard < 40) {
    const next = mutateWord(normalized);
    if (next && next !== normalized) {
      variants.add(next);
    }
    guard += 1;
  }
  if (variants.size < total - 1) {
    return null;
  }
  return [normalized, ...Array.from(variants)];
};

const createAudio = () => {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const play = (frequency: number, duration: number, type: OscillatorType) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.stop(ctx.currentTime + duration);
  };
  return {
    correct: () => play(520, 0.2, "sine"),
    wrong: () => play(180, 0.3, "square"),
  };
};

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<ReturnType<typeof createAudio> | null>(null);
  const statsRef = useRef<Record<string, WordStat>>(loadStats());
  const lastWordRef = useRef<string | undefined>(undefined);

  const [stage, setStage] = useState<Stage>("load");
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [removeEmpty, setRemoveEmpty] = useState(true);
  const [removeDuplicates, setRemoveDuplicates] = useState(true);
  const [wordPool, setWordPool] = useState<WordEntry[]>([]);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [sessionLength, setSessionLength] = useState<SessionLength>(10);
  const [session, setSession] = useState<SessionState>({
    timeLeft: 0,
    energy: 100,
    score: 0,
    streak: 0,
    longestStreak: 0,
    combo: 1,
    correct: 0,
    incorrect: 0,
  });
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [feedback, setFeedback] = useState<"idle" | "correct" | "wrong">(
    "idle"
  );
  const [typedAnswer, setTypedAnswer] = useState("");
  const [questionTimeLeft, setQuestionTimeLeft] = useState(0);
  const [paused, setPaused] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [dailyGoal, setDailyGoal] = useState<DailyGoal>(loadDaily());
  const [missedWords, setMissedWords] = useState<string[]>([]);

  const parsed = useMemo(
    () => parseLines(rawText, removeEmpty, removeDuplicates),
    [rawText, removeEmpty, removeDuplicates]
  );

  const preview = parsed.entries.slice(0, 6);

  useEffect(() => {
    if (stage !== "play" || paused || sessionLength === "zen") {
      return;
    }
    const timer = window.setInterval(() => {
      setSession((prev) => {
        if (prev.timeLeft <= 1) {
          return { ...prev, timeLeft: 0 };
        }
        return { ...prev, timeLeft: prev.timeLeft - 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [stage, paused, sessionLength]);

  const endSession = useCallback(() => {
    setStage("summary");
    saveStats(statsRef.current);
  }, []);

  useEffect(() => {
    if (stage !== "play") {
      return;
    }
    if (session.energy <= 0) {
      endSession();
    } else if (sessionLength !== "zen" && session.timeLeft <= 0) {
      endSession();
    }
  }, [session.energy, session.timeLeft, stage, sessionLength, endSession]);

  useEffect(() => {
    if (stage !== "play") {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (paused) {
        if (event.key.toLowerCase() === "p") {
          setPaused(false);
        }
        return;
      }
      if (event.key.toLowerCase() === "p") {
        setPaused(true);
        return;
      }
      if (event.key.toLowerCase() === "m") {
        setSoundOn((prev) => !prev);
        return;
      }
      if (feedback !== "idle") {
        if (event.key.toLowerCase() === "n") {
          handleSelfRating("neutral");
        }
        return;
      }
      if (currentQuestion?.mode === "choice") {
        const idx = Number(event.key);
        if (!Number.isNaN(idx) && idx > 0) {
          handleChoice(idx - 1);
        }
      } else if (currentQuestion?.mode === "type") {
        if (event.key === "Enter") {
          submitTyped();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentQuestion, feedback, paused, stage, typedAnswer]);

  const ensureAudio = () => {
    if (!audioRef.current) {
      audioRef.current = createAudio();
    }
  };

  const speakWord = (word: string) => {
    if (!soundOn || !("speechSynthesis" in window)) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  const handleFilePick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result || ""));
      setStage("load");
    };
    reader.readAsText(file);
  };

  const applyWordPool = () => {
    setWordPool(parsed.entries);
    setStage("setup");
  };

  const startSession = () => {
    if (wordPool.length < 2) {
      return;
    }
    setMissedWords([]);
    const timeLeft =
      sessionLength === "zen" ? 0 : Number(sessionLength) * 60;
    setSession({
      timeLeft,
      energy: 100,
      score: 0,
      streak: 0,
      longestStreak: 0,
      combo: 1,
      correct: 0,
      incorrect: 0,
    });
    setFeedback("idle");
    setPaused(false);
    setTypedAnswer("");
    setStage("play");
    nextQuestion();
  };

  const nextQuestion = () => {
    const stats = statsRef.current;
    const entry = pickWeighted(wordPool, stats, lastWordRef.current);
    lastWordRef.current = entry.word;
    const { full, cloze } = sentenceFor(entry.word);
    let prompt = "";
    let mode: Question["mode"] = "choice";
    if (difficulty === "easy") {
      prompt = entry.hint
        ? `Hint: ${entry.hint}`
        : `Select the correct word: ${cloze}`;
    } else if (difficulty === "normal") {
      prompt = entry.hint
        ? `Hint: ${entry.hint}`
        : `Select the correct word: ${cloze}`;
    } else {
      mode = "type";
      prompt = entry.hint
        ? `Type the word for: ${entry.hint}`
        : `Type the word that completes: ${cloze}`;
    }

    let choices: WordEntry[] = [];
    let correctIndex = -1;
    if (mode === "choice") {
      const size = Math.min(4, Math.max(2, wordPool.length));
      if (difficulty === "normal") {
        const variants = similarChoices(entry.word, size);
        if (variants) {
          choices = variants.map((value, index) => ({
            id: `${entry.id}-var-${index}`,
            word: value,
            hint: entry.hint,
          }));
          choices.sort(() => Math.random() - 0.5);
          correctIndex = choices.findIndex(
            (choice) => choice.word === entry.word
          );
        } else {
          choices = pickChoices(wordPool, entry, size);
          correctIndex = choices.findIndex(
            (choice) => choice.word === entry.word
          );
        }
      } else {
        choices = pickChoices(wordPool, entry, size);
        correctIndex = choices.findIndex(
          (choice) => choice.word === entry.word
        );
      }
    }
    setCurrentQuestion({
      entry,
      choices,
      correctIndex,
      prompt,
      example: full,
      mode,
    });
    setFeedback("idle");
    setTypedAnswer("");
    setQuestionTimeLeft(difficulty === "easy" ? 5 : 0);
  };

  const applyAnswer = (isCorrect: boolean) => {
    const entry = currentQuestion?.entry;
    if (!entry) {
      return;
    }
    const now = Date.now();
    const stats = statsRef.current;
    ensureStats(stats, entry);
    const stat = stats[entry.word];
    stat.exposures += 1;
    stat.lastSeen = now;
    if (isCorrect) {
      stat.correct += 1;
      stat.mastery = clamp(stat.mastery + 0.08, 0, 1);
    } else {
      stat.incorrect += 1;
      stat.lastMiss = now;
      stat.mastery = clamp(stat.mastery - 0.12, 0, 1);
      setMissedWords((prev) =>
        prev.includes(entry.word) ? prev : [...prev, entry.word]
      );
    }
    saveStats(stats);

    setSession((prev) => {
      const streak = isCorrect ? prev.streak + 1 : 0;
      const longestStreak = Math.max(prev.longestStreak, streak);
      const combo = isCorrect ? clamp(1 + Math.floor(streak / 3), 1, 5) : 1;
      const score = prev.score + (isCorrect ? 10 * combo : 0);
      const energy = clamp(
        prev.energy + (isCorrect ? 8 : -18),
        0,
        100
      );
      return {
        ...prev,
        streak,
        longestStreak,
        combo,
        score,
        energy,
        correct: prev.correct + (isCorrect ? 1 : 0),
        incorrect: prev.incorrect + (isCorrect ? 0 : 1),
      };
    });

    if (isCorrect) {
      const updatedDaily = { ...dailyGoal, correct: dailyGoal.correct + 1 };
      setDailyGoal(updatedDaily);
      saveDaily(updatedDaily);
    }

    if (soundOn) {
      ensureAudio();
      if (isCorrect) {
        audioRef.current?.correct();
      } else {
        audioRef.current?.wrong();
      }
    }
    speakWord(entry.word);

    setFeedback(isCorrect ? "correct" : "wrong");
  };

  useEffect(() => {
    if (
      stage !== "play" ||
      paused ||
      feedback !== "idle" ||
      difficulty !== "easy" ||
      !currentQuestion ||
      questionTimeLeft <= 0
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setQuestionTimeLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [
    stage,
    paused,
    feedback,
    difficulty,
    currentQuestion,
    questionTimeLeft,
  ]);

  useEffect(() => {
    if (
      stage === "play" &&
      difficulty === "easy" &&
      feedback === "idle" &&
      currentQuestion &&
      questionTimeLeft === 0
    ) {
      applyAnswer(false);
    }
  }, [
    stage,
    difficulty,
    feedback,
    currentQuestion,
    questionTimeLeft,
  ]);

  const handleChoice = (index: number) => {
    if (!currentQuestion || feedback !== "idle") {
      return;
    }
    if (index < 0 || index >= currentQuestion.choices.length) {
      return;
    }
    const isCorrect = index === currentQuestion.correctIndex;
    applyAnswer(isCorrect);
  };

  const submitTyped = () => {
    if (!currentQuestion || feedback !== "idle") {
      return;
    }
    const isCorrect =
      typedAnswer.trim().toLowerCase() ===
      currentQuestion.entry.word.toLowerCase();
    applyAnswer(isCorrect);
  };

  const handleSelfRating = (rating: "know" | "unsure" | "neutral") => {
    if (!currentQuestion) {
      return;
    }
    const stats = statsRef.current;
    ensureStats(stats, currentQuestion.entry);
    const stat = stats[currentQuestion.entry.word];
    if (rating === "know") {
      stat.mastery = clamp(stat.mastery + 0.1, 0, 1);
    } else if (rating === "unsure") {
      stat.mastery = clamp(stat.mastery - 0.1, 0, 1);
    }
    saveStats(stats);
    nextQuestion();
  };

  const weakWords = useMemo(() => {
    const stats = statsRef.current;
    const list = wordPool
      .map((entry) => {
        ensureStats(stats, entry);
        return { word: entry.word, mastery: stats[entry.word].mastery };
      })
      .sort((a, b) => a.mastery - b.mastery)
      .slice(0, 6);
    return list;
  }, [wordPool, stage]);

  const exportMissed = () => {
    if (missedWords.length === 0) {
      return;
    }
    const blob = new Blob([missedWords.join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "neon-drift-review.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const accuracy =
    session.correct + session.incorrect > 0
      ? Math.round(
          (session.correct / (session.correct + session.incorrect)) * 100
        )
      : 0;

  return (
    <div className="app">
      <div className="background" />
      <header className="topbar">
        <div>
          <p className="eyebrow">Neon Drift: Word Runner</p>
          <h1>Drift. Learn. Lock in.</h1>
          <p className="subtitle">
            A neon runner for vocabulary speed and mastery.
          </p>
        </div>
        <div className="meta">
          <div className="goal">
            <span>Daily goal</span>
            <strong>
              {Math.min(dailyGoal.correct, DAILY_TARGET)}/{DAILY_TARGET}
            </strong>
            <div className="bar">
              <div
                className="bar-fill"
                style={{
                  width: `${Math.min(
                    100,
                    (dailyGoal.correct / DAILY_TARGET) * 100
                  )}%`,
                }}
              />
            </div>
          </div>
          <button
            className={`btn ghost ${soundOn ? "active" : ""}`}
            onClick={() => setSoundOn((prev) => !prev)}
          >
            Sound {soundOn ? "On" : "Off"} (M)
          </button>
        </div>
      </header>

      {stage === "load" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Load your word list</h2>
            <p>Upload a .txt file with one word per line.</p>
          </div>
          <div className="load-row">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              onChange={handleFileChange}
              hidden
            />
            <button className="btn primary" onClick={handleFilePick}>
              Load Words (.txt)
            </button>
            {fileName && <span className="file-name">{fileName}</span>}
          </div>

          <div className="cleanup">
            <label className="toggle">
              <input
                type="checkbox"
                checked={removeEmpty}
                onChange={(event) => setRemoveEmpty(event.target.checked)}
              />
              Remove empty lines ({parsed.emptyCount})
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={removeDuplicates}
                onChange={(event) => setRemoveDuplicates(event.target.checked)}
              />
              Remove duplicates ({parsed.duplicateCount})
            </label>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <span>Total lines</span>
              <strong>{parsed.totalLines}</strong>
            </div>
            <div className="stat-card">
              <span>Usable words</span>
              <strong>{parsed.entries.length}</strong>
            </div>
            <div className="stat-card">
              <span>Preview</span>
              <div className="preview">
                {preview.length === 0 ? (
                  <em>No entries yet.</em>
                ) : (
                  preview.map((entry) => (
                    <span key={entry.id}>
                      {entry.word}
                      {entry.hint ? ` — ${entry.hint}` : ""}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="actions">
            <button
              className="btn primary"
              onClick={applyWordPool}
              disabled={parsed.entries.length < 2}
            >
              Use these words
            </button>
            <p className="hint">
              Need at least 2 usable words to begin.
            </p>
          </div>
        </section>
      )}

      {stage === "setup" && (
        <section className="panel">
          <div className="panel-header">
            <h2>Session setup</h2>
            <p>Pick a drift length and your challenge mode.</p>
          </div>
          <div className="setup-grid">
            <div>
              <h3>Session length</h3>
              <div className="choice-row">
                {[5, 10, 20].map((value) => (
                  <button
                    key={value}
                    className={`btn choice ${
                      sessionLength === value ? "active" : ""
                    }`}
                    onClick={() => setSessionLength(value as SessionLength)}
                  >
                    {value} min
                  </button>
                ))}
                <button
                  className={`btn choice ${
                    sessionLength === "zen" ? "active" : ""
                  }`}
                  onClick={() => setSessionLength("zen")}
                >
                  Zen mode
                </button>
              </div>
            </div>
            <div>
              <h3>Difficulty</h3>
              <div className="choice-row">
                {(["easy", "normal", "hard"] as Difficulty[]).map((level) => (
                  <button
                    key={level}
                    className={`btn choice ${
                      difficulty === level ? "active" : ""
                    }`}
                    onClick={() => setDifficulty(level)}
                  >
                    {level === "easy" && "Easy + hint"}
                    {level === "normal" && "Normal"}
                    {level === "hard" && "Hard typing"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="actions">
            <button className="btn primary" onClick={startSession}>
              Start drift
            </button>
            <button className="btn ghost" onClick={() => setStage("load")}>
              Back to list
            </button>
          </div>
        </section>
      )}

      {stage === "play" && currentQuestion && (
        <section className="panel play">
          <div className="hud">
            <div className="hud-left">
              <div className="meter">
                <span>Energy</span>
                <div className="bar">
                  <div
                    className="bar-fill neon"
                    style={{ width: `${session.energy}%` }}
                  />
                </div>
              </div>
              <div className="meter">
                <span>Streak</span>
                <strong>{session.streak}</strong>
              </div>
              <div className="meter">
                <span>Combo</span>
                <strong>x{session.combo}</strong>
              </div>
            </div>
            <div className="hud-center">
              <div className="score">
                <span>Score</span>
                <strong>{session.score}</strong>
              </div>
              <div className="timer">
                <span>{sessionLength === "zen" ? "Zen" : "Time"}</span>
                <strong>
                  {sessionLength === "zen"
                    ? "--:--"
                    : `${Math.floor(session.timeLeft / 60)
                        .toString()
                        .padStart(2, "0")}:${(session.timeLeft % 60)
                        .toString()
                        .padStart(2, "0")}`}
                </strong>
              </div>
            </div>
            <div className="hud-right">
              <button className="btn ghost" onClick={() => setPaused(true)}>
                Pause (P)
              </button>
              <button
                className="btn ghost"
                onClick={() => setSoundOn((prev) => !prev)}
              >
                Sound {soundOn ? "On" : "Off"}
              </button>
            </div>
          </div>

          <div className="prompt">
            <p>{currentQuestion.prompt}</p>
            {difficulty === "easy" && (
              <span className="prompt-timer">
                Time left: {questionTimeLeft}s
              </span>
            )}
          </div>

          {currentQuestion.mode === "choice" && (
            <div className="lanes">
              {currentQuestion.choices.map((choice, index) => (
                <button
                  key={`${choice.word}-${index}`}
                  className="lane-card"
                  onClick={() => handleChoice(index)}
                  disabled={feedback !== "idle"}
                >
                  <span className="lane-key">{index + 1}</span>
                  <strong>{choice.word}</strong>
                </button>
              ))}
            </div>
          )}

          {currentQuestion.mode === "type" && (
            <div className="type-input">
              <input
                autoFocus
                value={typedAnswer}
                onChange={(event) => setTypedAnswer(event.target.value)}
                placeholder="Type the word and press Enter"
                disabled={feedback !== "idle"}
              />
              <button
                className="btn primary"
                onClick={submitTyped}
                disabled={feedback !== "idle"}
              >
                Submit
              </button>
            </div>
          )}

          {feedback !== "idle" && (
            <div className={`feedback ${feedback}`}>
              <strong>{feedback === "correct" ? "Nice drift!" : "Close!"}</strong>
              <p>
                {currentQuestion.entry.word}
                {currentQuestion.entry.hint
                  ? ` — ${currentQuestion.entry.hint}`
                  : ""}
              </p>
              <p className="example">{currentQuestion.example}</p>
              <div className="rating">
                <span>How did that feel?</span>
                <button
                  className="btn choice"
                  onClick={() => handleSelfRating("know")}
                >
                  I know this
                </button>
                <button
                  className="btn choice"
                  onClick={() => handleSelfRating("unsure")}
                >
                  Not sure
                </button>
                <button
                  className="btn ghost"
                  onClick={() => handleSelfRating("neutral")}
                >
                  Next (N)
                </button>
              </div>
            </div>
          )}

          {paused && (
            <div className="pause-overlay">
              <div className="pause-card">
                <h3>Paused</h3>
                <p>Take a breath. Press P to resume.</p>
                <button className="btn primary" onClick={() => setPaused(false)}>
                  Resume
                </button>
                <button className="btn ghost" onClick={endSession}>
                  End session
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {stage === "summary" && (
        <section className="panel summary">
          <div className="panel-header">
            <h2>Session complete</h2>
            <p>Nice run. Review your stats and refuel.</p>
          </div>
          <div className="stats-grid">
            <div className="stat-card">
              <span>Accuracy</span>
              <strong>{accuracy}%</strong>
            </div>
            <div className="stat-card">
              <span>Correct</span>
              <strong>{session.correct}</strong>
            </div>
            <div className="stat-card">
              <span>Longest streak</span>
              <strong>{session.longestStreak}</strong>
            </div>
            <div className="stat-card">
              <span>Score</span>
              <strong>{session.score}</strong>
            </div>
          </div>
          <div className="summary-grid">
            <div>
              <h3>Top weak words</h3>
              {weakWords.length === 0 ? (
                <p>Load more words to see insights.</p>
              ) : (
                <ul>
                  {weakWords.map((item) => (
                    <li key={item.word}>
                      <strong>{item.word}</strong> — mastery{" "}
                      {Math.round(item.mastery * 100)}%
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Review list</h3>
              <p>
                {missedWords.length === 0
                  ? "No missed words this run."
                  : `${missedWords.length} words ready to export.`}
              </p>
              <button
                className="btn primary"
                onClick={exportMissed}
                disabled={missedWords.length === 0}
              >
                Download missed words
              </button>
            </div>
          </div>
          <div className="actions">
            <button className="btn primary" onClick={() => setStage("setup")}>
              New session
            </button>
            <button className="btn ghost" onClick={() => setStage("load")}>
              Load new list
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
