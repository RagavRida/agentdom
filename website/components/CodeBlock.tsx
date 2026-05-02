interface CodeBlockProps {
  code: string;
  label?: string;
  small?: boolean;
}

export default function CodeBlock({ code, label, small }: CodeBlockProps) {
  return (
    <div className={`code-block ${small ? 'code-sm' : ''}`}>
      {label && (
        <div className="code-bar">
          <span className="dot r" /><span className="dot y" /><span className="dot g" />
          <span className="code-bar-label">{label}</span>
        </div>
      )}
      <pre><code dangerouslySetInnerHTML={{ __html: code }} /></pre>
    </div>
  );
}
