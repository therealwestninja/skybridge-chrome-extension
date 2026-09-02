// Secretary / practical knowledge pack (authored, expandable). Units, time, and productivity
// facts the brain can answer offline. Actual task execution (reminders/scheduling) is future. ASCII-only.
export const FACTS = [
  // units
  { s: "units", k: ["mile", "miles", "kilometre", "km"], a: "One mile is about 1.609 kilometres; one kilometre is about 0.621 miles." },
  { s: "units", k: ["pound", "kilogram", "kg"], a: "One kilogram is about 2.205 pounds." },
  { s: "units", k: ["inch", "centimetre", "cm"], a: "One inch is 2.54 centimetres." },
  { s: "units", k: ["foot", "feet", "metre", "meter"], a: "One foot is about 0.305 metres; one metre is about 3.281 feet." },
  { s: "units", k: ["fahrenheit", "celsius"], a: "To convert Celsius to Fahrenheit, multiply by 9/5 and add 32." },
  { s: "units", k: ["gallon", "litre", "liter"], a: "One US gallon is about 3.785 litres." },
  // time and dates
  { s: "time", k: ["week", "days"], a: "A week has 7 days; a non-leap year has 365 days and a leap year 366." },
  { s: "time", k: ["months"], a: "A year has 12 months; the 30-day months are April, June, September, and November." },
  { s: "time", k: ["leap year"], a: "A leap year occurs every 4 years (except century years not divisible by 400), adding February 29." },
  { s: "time", k: ["hour", "minutes", "seconds"], a: "An hour is 60 minutes; a minute is 60 seconds; a day is 24 hours." },
  { s: "time", k: ["quarter", "quarters"], a: "A business year has four quarters of three months each: Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4 Oct-Dec." },
  // productivity / office
  { s: "productivity", k: ["pomodoro"], a: "The Pomodoro technique works in 25-minute focus blocks separated by short breaks." },
  { s: "productivity", k: ["agenda", "minutes", "meeting"], a: "An agenda lists what a meeting will cover; minutes record what was decided and who will do what." },
  { s: "productivity", k: ["deadline", "due"], a: "A deadline is the latest time a task may be completed; track it against today's date to prioritize." },
  { s: "productivity", k: ["priority", "prioritize"], a: "Prioritize by urgency and importance: do urgent-important first, schedule important-not-urgent, drop the rest." },
  { s: "productivity", k: ["todo", "checklist"], a: "A to-do list captures tasks so you don't hold them in your head; check items off as you finish them." },
  { s: "language", k: ["palindrome"], a: "A palindrome reads the same forwards and backwards, like the word level." },
  { s: "language", k: ["acronym"], a: "An acronym is a word made from the first letters of a phrase, like NASA." },
];
