/**
 * Utility functions for SusWord server.
 */

const ROOM_CODE_LENGTH = 4
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1 to avoid confusion

/**
 * Generate a random room code.
 */
function generateRoomCode() {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)]
  }
  return code
}

module.exports = { generateRoomCode }
