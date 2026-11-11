import { randomInt } from "node:crypto";
import type { GeneratedSecretRules } from "@rakazo/contracts";
import { generatedSecretAlphabets } from "@rakazo/contracts";

/** Sample each enabled character class, then shuffle so their positions are random. */
export function generateSecretValue(rules: GeneratedSecretRules): string {
  const sets = generatedSecretAlphabets(rules);
  const all = sets.join("");
  const characters = sets.map(pick);
  while (characters.length < rules.length) characters.push(pick(all));
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other]!, characters[index]!];
  }
  return characters.join("");
}

function pick(set: string): string {
  return set[randomInt(set.length)]!;
}
