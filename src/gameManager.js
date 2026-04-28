/**
 * Game manager — handles round creation, word assignment, reveal readiness,
 * and clue round state.
 * Keeps round data on the room object in memory.
 */

// ── Word pairs (small inline list for MVP) ─────────────────
const WORD_PAIRS = [
  { mainWord: 'Pizza', imposterWord: 'Burger', category: 'Food' },
  { mainWord: 'Doctor', imposterWord: 'Nurse', category: 'Jobs' },
  { mainWord: 'Ocean', imposterWord: 'Beach', category: 'Places' },
  { mainWord: 'Mango', imposterWord: 'Papaya', category: 'Food' },
  { mainWord: 'Guitar', imposterWord: 'Ukulele', category: 'Objects' },
  { mainWord: 'Dolphin', imposterWord: 'Whale', category: 'Animals' },
  { mainWord: 'Coffee', imposterWord: 'Espresso', category: 'Food' },
  { mainWord: 'Castle', imposterWord: 'Palace', category: 'Places' },
  { mainWord: 'Thunder', imposterWord: 'Lightning', category: 'Nature' },
  { mainWord: 'Painting', imposterWord: 'Drawing', category: 'Activities' },
  { mainWord: 'Jacket', imposterWord: 'Coat', category: 'Clothing' },
  { mainWord: 'Sunset', imposterWord: 'Sunrise', category: 'Nature' },
  { mainWord: 'Soup', imposterWord: 'Stew', category: 'Food' },
  { mainWord: 'Wolf', imposterWord: 'Fox', category: 'Animals' },
  { mainWord: 'Lake', imposterWord: 'Pond', category: 'Places' },
  { mainWord: 'Frog', imposterWord: 'Toad', category: 'Animals' },
  { mainWord: 'Sword', imposterWord: 'Dagger', category: 'Objects' },
  { mainWord: 'Jogging', imposterWord: 'Sprinting', category: 'Activities' },
  { mainWord: 'Pancake', imposterWord: 'Waffle', category: 'Food' },
  { mainWord: 'Hill', imposterWord: 'Mountain', category: 'Nature' },
]

/**
 * Start a new round for the given room.
 */
function startRound(room) {
  const wordPair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)]
  const imposterIdx = Math.floor(Math.random() * room.players.length)
  const imposterId = room.players[imposterIdx].id

  const assignments = {}
  room.players.forEach(p => {
    assignments[p.id] = {
      word: p.id === imposterId ? wordPair.imposterWord : wordPair.mainWord,
    }
  })

  const turnOrder = room.players
    .map(p => p.id)
    .sort(() => Math.random() - 0.5)

  room.roundData = {
    wordPair,
    imposterId,
    assignments,
    turnOrder,
    readyPlayers: [],
    // Clue round state
    clues: [],
    currentTurnIdx: 0,
    clueRoundComplete: false,
    // Voting state
    votes: {},            // { voterId: targetId }
    votedPlayers: [],
    votedOutId: null,
    voteTally: null,
    winner: null,
    finalGuess: null,
  }

  room.gameState = 'REVEAL'
  return room.roundData
}

/**
 * Get the PRIVATE reveal payload for a specific player.
 */
function getPlayerRevealData(room, socketId) {
  const rd = room.roundData
  if (!rd || !rd.assignments[socketId]) return null

  return {
    word: rd.assignments[socketId].word,
    gameState: room.gameState,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
    })),
  }
}

/**
 * Mark a player as ready after viewing their card.
 */
function setPlayerReady(room, socketId) {
  const rd = room.roundData
  if (!rd) return null

  if (!rd.readyPlayers.includes(socketId)) {
    rd.readyPlayers.push(socketId)
  }

  const totalCount = room.players.length
  const readyCount = rd.readyPlayers.length
  const allReady = readyCount >= totalCount

  return { allReady, readyCount, totalCount }
}

// ── Clue Round Logic ───────────────────────────────────────

function submitClue(room, socketId, clueText) {
  const rd = room.roundData
  if (!rd) return { error: 'No round data' }
  if (room.gameState !== 'CLUE_ROUND') return { error: 'Not in clue round' }

  if (rd.clues.some(c => c.playerId === socketId)) return { error: 'Already submitted' }

  const trimmed = clueText?.trim()
  if (!trimmed) return { error: 'Clue cannot be empty' }

  const player = room.players.find(p => p.id === socketId)
  if (!player) return { error: 'Player not found in room' }

  rd.clues.push({ playerId: socketId, playerName: player.name, clue: trimmed })

  if (rd.clues.length >= room.players.length) {
    rd.clueRoundComplete = true
    room.gameState = 'CLUE_REVEAL'
  }

  return { success: true, clueRoundComplete: rd.clueRoundComplete }
}

function forceCompleteClueRound(room) {
  const rd = room.roundData
  if (!rd) return
  
  room.players.forEach(p => {
    if (!rd.clues.some(c => c.playerId === p.id)) {
      rd.clues.push({ playerId: p.id, playerName: p.name, clue: '' })
    }
  })
  
  rd.clueRoundComplete = true
  room.gameState = 'CLUE_REVEAL'
}

function getClueRoundState(room) {
  const rd = room.roundData
  if (!rd) return null

  return {
    gameState: room.gameState,
    clueEndTime: rd.clueEndTime,
    submittedCount: rd.clues.length,
    totalCount: room.players.length,
    submittedPlayerIds: rd.clues.map(c => c.playerId),
    clues: rd.clues,
    clueRoundComplete: rd.clueRoundComplete,
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId })),
  }
}

function handleClueDisconnect(room, disconnectedId) {
  const rd = room.roundData
  if (!rd || room.gameState !== 'CLUE_ROUND') return false

  // If a player disconnects, check if we should auto-complete the round
  // because the missing player's submission is no longer needed to reach 100%
  // Or force empty clue immediately. For simplicity, just check completion.
  if (rd.clues.length >= room.players.length) {
    rd.clueRoundComplete = true
    room.gameState = 'CLUE_REVEAL'
  }
  return true
}

// ── Voting Logic ───────────────────────────────────────────

/**
 * Submit a vote. Returns { error } or { success, allVoted }
 */
function submitVote(room, voterId, targetId) {
  const rd = room.roundData
  if (!rd) return { error: 'No round data' }
  if (room.gameState !== 'VOTING') return { error: 'Not in voting phase' }
  if (rd.votedPlayers.includes(voterId)) return { error: 'Already voted' }

  // Cannot vote for yourself
  if (voterId === targetId) return { error: 'Cannot vote for yourself' }

  // Target must be a valid player
  if (!room.players.some(p => p.id === targetId)) return { error: 'Invalid target' }

  rd.votes[voterId] = targetId
  rd.votedPlayers.push(voterId)

  const allVoted = rd.votedPlayers.length >= room.players.length

  return { success: true, allVoted, votedCount: rd.votedPlayers.length, totalCount: room.players.length }
}

/**
 * Count votes and determine who is voted out.
 * Tie rule: If tie, no one is eliminated -> Imposter wins.
 */
function resolveVotes(room) {
  const rd = room.roundData
  if (!rd) return null

  // Tally votes
  const tally = {}
  Object.values(rd.votes).forEach(targetId => {
    tally[targetId] = (tally[targetId] || 0) + 1
  })

  const voteValues = Object.values(tally)
  const maxVotes = voteValues.length > 0 ? Math.max(...voteValues) : 0
  const tied = Object.keys(tally).filter(id => tally[id] === maxVotes)

  let votedOutId = null
  let imposterCaught = false

  // If there's a tie for the highest votes (and more than 0 votes cast), no one is eliminated
  if (tied.length > 1 || maxVotes === 0) {
    votedOutId = null
    imposterCaught = false
    rd.winner = 'IMPOSTER' // On tie or no votes, imposter survives and wins
  } else {
    votedOutId = tied[0]
    imposterCaught = votedOutId === rd.imposterId

    if (imposterCaught) {
      // Imposter caught — they get a chance to guess the main word
      rd.winner = null
    } else {
      // Civilian voted out — imposter wins immediately
      rd.winner = 'IMPOSTER'
    }
  }

  rd.votedOutId = votedOutId
  rd.voteTally = tally
  room.gameState = 'RESULT'

  return {
    votedOutId,
    voteTally: tally,
    imposterCaught,
    imposterId: rd.imposterId,
    winner: rd.winner,
    wordPair: rd.wordPair,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      isImposter: p.id === rd.imposterId,
    })),
  }
}

/**
 * Submit the imposter's final guess of the main word.
 */
function submitFinalGuess(room, guess) {
  const rd = room.roundData
  if (!rd || rd.winner !== null) return { error: 'No final guess needed' }

  const trimmed = guess?.trim()
  if (!trimmed) return { error: 'Guess cannot be empty' }

  rd.finalGuess = trimmed
  const correct = trimmed.toLowerCase() === rd.wordPair.mainWord.toLowerCase()
  rd.winner = correct ? 'IMPOSTER' : 'CIVILIANS'

  return {
    success: true,
    finalGuess: trimmed,
    correct,
    winner: rd.winner,
    wordPair: rd.wordPair,
  }
}

module.exports = {
  startRound,
  getPlayerRevealData,
  setPlayerReady,
  submitClue,
  forceCompleteClueRound,
  getClueRoundState,
  handleClueDisconnect,
  submitVote,
  resolveVotes,
  submitFinalGuess,
}

