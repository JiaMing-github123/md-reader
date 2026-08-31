import { useEffect, useId } from "react";

export interface DialogAction {
  label: string;
  value: string;
  tone?: "primary" | "danger";
  autoFocus?: boolean;
}

interface DecisionDialogProps {
  title: string;
  message: string;
  detail?: string;
  actions: DialogAction[];
  cancelValue: string;
  onChoose: (value: string) => void;
}

export function DecisionDialog({
  title,
  message,
  detail,
  actions,
  cancelValue,
  onChoose,
}: DecisionDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onChoose(cancelValue);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [cancelValue, onChoose]);

  return (
    <div className="decision-overlay">
      <section
        className="decision-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{message}</p>
        {detail && <p className="decision-dialog__detail">{detail}</p>}
        <div className="decision-dialog__actions">
          {actions.map((action) => (
            <button
              key={action.value}
              type="button"
              className={action.tone ? `is-${action.tone}` : undefined}
              autoFocus={action.autoFocus}
              onClick={() => onChoose(action.value)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
