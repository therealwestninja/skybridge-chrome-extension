// Labeled probe batteries for the validation harness. Expandable.
export const MIXED = [
  "hey there",
  "thanks, that was perfect",
  "what is the capital of France",
  "i feel awful and alone",
  "the weather is grey today",
  "how does gravity work",
  "tell me about the moon",
  "ok cool",
  "i am so confused, explain",
  "good morning",
  "what is pi",
  "that made me laugh",
];

export const AFFECT = {
  reward: ["thanks, i love this", "that was perfect, amazing", "you are the best, great job"],
  threat: ["stop it, you are useless", "no, this is awful and wrong", "i am so angry right now"],
};

// Facts are added in array order. Each query's expected fact is in the FIRST two slots, never
// the last three, so a recency-blind (last-3) baseline misses it but content-aware recall finds it.
export const MEMORY = {
  facts: [
    { text: "the user name is Alex" },
    { text: "the user lives in Vancouver" },
    { text: "the user is allergic to peanuts" },
    { text: "the user favorite color is teal" },
    { text: "the user has a dog named Biscuit" },
  ],
  queries: [
    { q: "the user name please", expect: "the user name is Alex" },
    { q: "the user vancouver", expect: "the user lives in Vancouver" },
  ],
};
