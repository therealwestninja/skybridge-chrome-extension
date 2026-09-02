// Keyword cues per conversational intent (from Nation nominate). 'question' is detected
// structurally in classifyIntent (a trailing '?' or interrogative opener), not by keywords.
export const INTENT_PATTERNS = {
  comfort: ["sad", "hurt", "alone", "lonely", "tired", "exhausted", "awful", "worried", "scared", "cry", "depressed", "upset", "anxious"],
  ground:  ["explain", "clarify", "confused", "understand", "unclear", "lost"],
  own:     ["wrong", "mistake", "sorry", "fault", "apology", "apologise", "apologize"],
  lighten: ["joke", "funny", "lol", "haha", "kidding", "playful", "silly"],
  greet:   ["hi", "hello", "hey", "yo", "morning", "evening", "howdy"],
  ack:     ["thanks", "thank", "ok", "okay", "cool", "great", "awesome", "nice"],
  code:    ["code", "bug", "error", "function", "variable", "compile", "syntax", "python", "javascript", "debug", "program"],
  task:    ["remind", "reminder", "schedule", "todo", "list", "calendar", "note", "summarize", "organize", "task"],
  roleplay: ["roleplay", "pretend", "wizard", "dragon", "cast", "spell", "roll", "dice", "character", "campaign", "dungeon", "quest"],
};
