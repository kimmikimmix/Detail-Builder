/* Snapshot undo/redo. Documents are small enough that whole-doc snapshots
   are simpler and safer than command diffs. */
(function (FB) {
  'use strict';

  const LIMIT = 120;

  const H = {
    stack: [],
    index: -1,
    onChange: null,

    reset(doc) {
      this.stack = [JSON.stringify(doc)];
      this.index = 0;
      this.notify();
    },

    /* Call after a completed edit. */
    commit(doc) {
      const snap = JSON.stringify(doc);
      if (snap === this.stack[this.index]) return false;
      this.stack.length = this.index + 1;
      this.stack.push(snap);
      if (this.stack.length > LIMIT) this.stack.shift();
      this.index = this.stack.length - 1;
      this.notify();
      return true;
    },

    canUndo() { return this.index > 0; },
    canRedo() { return this.index < this.stack.length - 1; },

    undo() {
      if (!this.canUndo()) return null;
      this.index--;
      this.notify();
      return JSON.parse(this.stack[this.index]);
    },

    redo() {
      if (!this.canRedo()) return null;
      this.index++;
      this.notify();
      return JSON.parse(this.stack[this.index]);
    },

    notify() { if (this.onChange) this.onChange(); },
  };

  FB.history = H;
})(window.FB);
