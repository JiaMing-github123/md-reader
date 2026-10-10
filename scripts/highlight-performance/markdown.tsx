import ReactMarkdown from "react-markdown";
export default function MeasuredMarkdown(props: any) {
  const start = performance.now();
  const result = ReactMarkdown(props);
  (window as any).__perf.markdown.push(performance.now() - start);
  return result;
}
