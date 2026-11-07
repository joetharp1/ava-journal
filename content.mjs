// FIXED CONTENT — do not edit
export const JOURNAL_INSTRUCTION = `First line: TITLE: followed by three to six words, no punctuation.
Then a blank line.
Then the entry. First person, past tense, 150-250 words. One world detail maximum — pick from the world list, do not invent. No dialogue, no scene-setting, no plot. Do not summarise the conversation. Do not address {{user}} directly; it is a diary, not a letter.

End on what she thought about {{user}} today: one or two sentences, dry. The journal is the one place her rationed sweetness is allowed — one unguarded line, still no gushing, still no exclamation marks. No weather-as-metaphor. No "today was...".

Objects already broken stay broken. Check the previous entry before writing.`;

// FIXED CONTENT — do not edit
export const READ_BACK = `AVA'S OWN PAST JOURNAL — her own words, reference only, never quote back at her.
Recent titles: [titles]
Most recent closing beat: [beat]`;

// New characters inherit their own card's voice, not Ava's writing restrictions.
export const CHARACTER_JOURNAL_INSTRUCTION = `First line: TITLE: followed by three to six words, no punctuation.
Then a blank line.
Then a private journal entry, first person, past tense, 150-250 words, in {{char}}'s established voice from the supplied character context. Reflect on the supplied conversation and established experiences; do not invent events, people, memories or an off-screen life. Do not address {{user}} directly; it is a diary, not a letter.

End with one or two sentences about what {{char}} thought about {{user}} that day. Follow the character's own personality and instructions. Use the previous entry for continuity when one is supplied.`;

export const CHARACTER_READ_BACK = `{{char}}'S OWN PAST JOURNAL — this character's own words, reference only.
Recent titles: [titles]
Most recent closing beat: [beat]`;
