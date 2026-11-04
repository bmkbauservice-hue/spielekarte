/** Fehler im Spiel mit maschinenlesbarem Code (für den Client) und deutschem Text (für Menschen). */
export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}
