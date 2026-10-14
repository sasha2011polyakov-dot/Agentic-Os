// A tool plugin receives its input and an `api` object. It cannot touch files, the network or other programs
// directly — every data request goes through the app and is checked against the permissions the user granted.
export default async function countWords(input, api) {
  const doc = await api.readDocument(input.docId);
  const text = doc.content.replace(/^---\n[\s\S]*?\n---\n/, '');
  const words = text.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const headings = text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).length;
  return { title: doc.title, words: words.length, characters: text.length, headings };
}
