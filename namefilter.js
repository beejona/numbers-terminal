/**
 * Leaderboard name rules, shared by the page (instant feedback while typing) and the leaderboard
 * server (the check that counts: the page's can be skipped by anyone who calls the server
 * directly).
 *
 * Names look like Minecraft names: 3 to 16 letters, digits and underscores. Slurs are refused
 * even when dressed up - "N1GG4", "n_i_g_g_a", "niiigga" and "nlgga" all read the same once a name
 * is flattened: lowercased, digits read as the letters they stand in for, underscores dropped and
 * repeated letters squeezed. Short stems that also sit inside ordinary words ("spic" in "spicy",
 * "coon" in "raccoon") only count as a whole word of the name.
 */

export const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

// Digits and look-alike letters as the letters they stand in for.
const LOOKALIKES = { "0": "o", "1": "i", "2": "z", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g" };
const LETTER_SWAPS = { l: "i", q: "g" };

// Found anywhere in a flattened name.
const ANYWHERE = [
  "nigger", "nigga", "nigor", "nigur", "niglet", "negroid",
  "faggot", "faggit", "fagget", "fagot",
  "retard",
  "tranny", "shemale",
  "chink", "chingchong",
  "wetback", "beaner",
  "jigaboo", "porchmonkey", "raghead", "towelhead", "zipperhead", "golliwog",
  "hitler"
].map(squeeze);

// Only as a whole word of the name (split at underscores, digits and capital letters).
const WHOLE = new Set([
  "fag", "fags", "tard", "tards", "trannie",
  "spic", "spick", "spics", "kike", "kikes", "kyke", "coon", "coons",
  "gook", "gooks", "paki", "pakis", "dyke", "dykes", "sambo", "nazi", "nazis", "negro", "negros"
]);

function squeeze(text) {
  return text.replace(/(.)\1+/g, "$1");
}

function readLetters(text) {
  return text.toLowerCase().replace(/[0-9]/g, digit => LOOKALIKES[digit]).replace(/[^a-z]/g, "");
}

/** The name's words: "xX_SpicLord99" -> xx, spic, lord (digits read as letters within a word). */
function words(name) {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\s]+|(?<=[A-Za-z])(?=[0-9]{2,})|(?<=[0-9]{2,})(?=[A-Za-z])/)
    .map(readLetters)
    .filter(Boolean);
}

/**
 * Whether [name] can go on the leaderboard: { ok: true } or { ok: false, reason } with a reason
 * fit to show the player.
 */
export function checkName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    return { ok: false, reason: "Use 3 to 16 letters, numbers or underscores." };
  }
  const raw = name.toLowerCase();
  const letters = readLetters(name);
  const variants = [letters, letters.replace(/[lq]/g, c => LETTER_SWAPS[c])].map(squeeze);
  const blocked =
    variants.some(flat => ANYWHERE.some(stem => flat.includes(stem))) ||
    WHOLE.has(letters) ||
    words(name).some(word => WHOLE.has(word) || WHOLE.has(squeeze(word))) ||
    raw.includes("kkk") || raw.includes("1488");
  return blocked ? { ok: false, reason: "That name isn't allowed." } : { ok: true };
}
