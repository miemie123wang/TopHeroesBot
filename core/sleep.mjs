export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function randomSleep(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(delay);
}