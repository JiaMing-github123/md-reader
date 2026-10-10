import { PrismLight } from "react-syntax-highlighter";

export function MeasuredHighlighter(props: any) {
  const start = performance.now();
  const result = (PrismLight as any)(props);
  (window as any).__perf.highlights.push({ ms: performance.now() - start, chars: String(props.children).length, language: props.language, code: String(props.children).slice(0,80) });
  return result;
}
MeasuredHighlighter.registerLanguage = PrismLight.registerLanguage;
(window as any).__benchmarkHighlight = (code: string, language: string, inline: boolean) => {
  const start = performance.now();
  (PrismLight as any)({children: code, language, useInlineStyles: inline});
  return performance.now() - start;
};
