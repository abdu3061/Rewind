import { useEffect, useRef, useState } from "react";
import type { PresentationState } from "@rewind/contracts";

export function usePresentation() {
  const [state, setState] = useState<PresentationState | null>(null);
  const revision = useRef(-1);
  useEffect(() => {
    const api = window.rewind?.presentation;
    if (!api) return;
    let live = true;
    const accept = (next: PresentationState) => {
      if (!live || next.revision < revision.current) return;
      revision.current = next.revision;
      setState(next);
    };
    const unsubscribe = api.onChanged(accept);
    void api.send({ action: "get" }).then((result) => {
      if (result.ok) accept(result.value);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}
