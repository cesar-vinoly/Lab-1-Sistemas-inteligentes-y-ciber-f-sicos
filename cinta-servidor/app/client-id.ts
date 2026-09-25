// crypto.randomUUID is unavailable on plain HTTP LAN pages. getRandomValues
// also works there; these IDs correlate messages and are not credentials.
export function clientId(){
  const words=new Uint32Array(4);
  crypto.getRandomValues(words);
  return Array.from(words,value=>value.toString(16).padStart(8,'0')).join('-');
}
