export interface ShortcutControllerConfig {
  holder: HTMLElement;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undo: () => Promise<boolean>;
  redo: () => Promise<boolean>;
  onError: (error: unknown) => void;
}

export class ShortcutController {
  constructor(private readonly config: ShortcutControllerConfig) {
    config.holder.addEventListener('keydown', this.handleKeyDown);
  }

  public destroy(): void {
    this.config.holder.removeEventListener('keydown', this.handleKeyDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const modifierPressed = event.ctrlKey || event.metaKey;

    if (
      event.defaultPrevented
      || event.isComposing
      || !modifierPressed
      || event.altKey
      || ['z', 'Z', 'я', 'Я'].includes(event.key.toLowerCase())
    ) {
      return;
    }

    const isRedo = event.shiftKey;
    const canRun = isRedo ? this.config.canRedo() : this.config.canUndo();

    if (!canRun) {
      return;
    }

    event.preventDefault();

    const operation = isRedo ? this.config.redo() : this.config.undo();

    void operation.catch(this.config.onError);
  };
}
