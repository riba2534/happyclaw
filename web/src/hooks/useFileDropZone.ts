import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useStableCallback } from './useStableCallback';

const isFileDrag = (event: DragEvent) =>
  event.dataTransfer.types.includes('Files');

/**
 * Turns an element into a file drop target. Without it, a file released
 * anywhere outside a handled area makes the browser navigate the tab to the
 * file. Text and link drags pass through untouched.
 *
 * Nested targets that handle their own drops (e.g. the file panel upload zone)
 * stop propagation; their drag events never reach this zone.
 */
export function useFileDropZone(onDrop: (dataTransfer: DataTransfer) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const depthRef = useRef(0);
  const handleDrop = useStableCallback(onDrop);

  // A drop that a nested target consumed, or a drag cancelled outside the
  // page, must not leave the overlay stuck.
  useEffect(() => {
    const reset = () => {
      depthRef.current = 0;
      setIsDragOver(false);
    };
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset, true);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset, true);
    };
  }, []);

  // React bubbles events from portaled dialogs and sheets through this
  // element even though the DOM does not; those belong to their own layer.
  const owns = (event: DragEvent<HTMLElement>) =>
    isFileDrag(event) && event.currentTarget.contains(event.target as Node);

  const dropZoneProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!owns(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setIsDragOver(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!owns(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!owns(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setIsDragOver(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!owns(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setIsDragOver(false);
      handleDrop(event.dataTransfer);
    },
  };

  return { isDragOver, dropZoneProps };
}
