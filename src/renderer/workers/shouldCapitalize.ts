export const shouldAllCapitalized = (word: string): boolean => {
  const lower = word.toLowerCase();
  // List of words that should always be capitalized
  const alwaysCapitalize = new Set([
    'i',
    'usa',
    'uk',
    'nasa',
    'fbi',
    'cia',
    'un',
    'eu',
    'dna',
    'html',
    'css',
    'javascript',
    'python',
    'java',
    'sql',
    'api',
    'gpu',
    'cpu',
    'ram',
    'ssd',
    'hdd'
  ]);

  return alwaysCapitalize.has(lower);
};

export const shouldCapitalize = (word: string): boolean => {
  //list of common English words that should be capitalized
  const commonCapitalizedWords = new Set([
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'april',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'english',
    'spanish',
    'french',
    'german',
    'chinese',
    'japanese',
    'russian',
    'italian',
    'portuguese',
    'arabic',
    'hindi',
    'easter',
    'christmas',
    'thanksgiving',
    'halloween',
    'new year',
    "valentine's day",
    'independence day',
    'memorial day',
    'labor day',
    'columbus day',
    'veterans day',
    "presidents' day",
    'celsius',
    'fahrenheit'
  ]);

  return commonCapitalizedWords.has(word);
};
