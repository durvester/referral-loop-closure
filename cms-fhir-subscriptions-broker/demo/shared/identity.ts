// Random patient identity generator

const FIRST_NAMES = [
  "Alice", "Maria", "James", "Carlos", "Priya", "Kenji", "Fatima", "Elena",
  "David", "Sarah", "Omar", "Yuki", "Rosa", "Thomas", "Amara", "Liam",
  "Sofia", "Andre", "Mei", "Noah", "Zara", "Ivan", "Nia", "Leo",
  "Grace", "Raj", "Hana", "Oscar", "Chloe", "Felix",
];

const MIDDLE_INITIALS = "A B C D E F G H J K L M N P R S T V W".split(" ");

const LAST_NAMES = [
  "Rodriguez", "Chen", "Patel", "Okafor", "Kim", "Mueller", "Santos",
  "Nakamura", "Thompson", "Garcia", "Andersen", "Nguyen", "Kowalski",
  "Hassan", "Yamamoto", "Rivera", "Johansson", "Abadi", "Reeves", "Park",
  "Ferreira", "Ivanova", "Mensah", "Larsson", "Delgado", "Tanaka",
  "Morrison", "Gupta", "Fischer", "Rossi",
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomHex(len: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

export function generateRandomPatient() {
  const first = randomItem(FIRST_NAMES);
  const middle = randomItem(MIDDLE_INITIALS);
  const last = randomItem(LAST_NAMES);
  const name = `${first} ${middle} ${last}`;

  // Random DOB between 1950 and 2000
  const year = 1950 + Math.floor(Math.random() * 50);
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, "0");
  const birthDate = `${year}-${month}-${day}`;

  const sourceId = `pat-${randomHex(8)}`;

  return { name, birthDate, sourceId };
}
