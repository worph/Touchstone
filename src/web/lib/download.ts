/**
 * Hand the reader a file the browser already has.
 *
 * A blob URL rather than a link to the API: the bytes are on the page — a report body, a fix
 * brief — and a second fetch to save what is already rendered is a second thing that can 404.
 */
export function download(filename: string, text: string, type = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
