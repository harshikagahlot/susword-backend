const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')
const { createRoom, joinRoom, leaveRoom, getRoom, getRoomBySocketId } = require('./roomManager')
const { startRound, getPlayerRevealData, setPlayerReady, submitClue, getClueRoundState, handleClueDisconnect, submitVote, resolveVotes, submitFinalGuess } = require('./gameManager')

const PORT = process.env.PORT || 3001

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      console.log(`🔗 Incoming socket connection from origin: ${origin || 'none'}`)
      const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []
      
      // Allow localhost, mobile apps (no origin), specific env origins, wildcard (*), and Vercel subdomains
      if (
        !origin || 
        /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) || 
        /\.vercel\.app$/.test(origin) ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.includes('*')
      ) {
        callback(null, true)
      } else {
        console.error(`❌ CORS blocked connection from origin: ${origin}`)
        callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST'],
  },
})

app.get('/', (req, res) => {
  res.json({ status: 'SusWord server running', port: PORT })
})

// ── Socket.IO ──────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`⚡ Connected: ${socket.id}`)

  // ── Create Room ──────────────────────────────────────────
  socket.on('create-room', ({ playerName }, callback) => {
    const result = createRoom(socket.id, playerName)
    if (result.error) return callback({ error: result.error })

    const { room, player } = result
    socket.join(room.roomCode)

    callback({
      roomCode: room.roomCode,
      playerId: player.id,
      players: room.players,
      hostId: room.hostId,
    })
    console.log(`🏠 Room ${room.roomCode} created by ${playerName}`)
  })

  // ── Join Room ────────────────────────────────────────────
  socket.on('join-room', ({ roomCode, playerName }, callback) => {
    const result = joinRoom(socket.id, roomCode, playerName)
    if (result.error) return callback({ error: result.error })

    const { room, player } = result
    socket.join(room.roomCode)

    callback({
      roomCode: room.roomCode,
      playerId: player.id,
      players: room.players,
      hostId: room.hostId,
    })

    socket.to(room.roomCode).emit('lobby-update', {
      players: room.players,
      hostId: room.hostId,
    })
    console.log(`👤 ${playerName} joined room ${roomCode}`)
  })

  // ── Leave Room ───────────────────────────────────────────
  socket.on('leave-room', () => {
    handleDisconnect(socket)
  })

  // ── Start Game ───────────────────────────────────────────
  socket.on('start-game', (callback) => {
    const room = getRoomBySocketId(socket.id)

    if (!room) return callback?.({ error: 'Room not found' })
    if (room.hostId !== socket.id) return callback?.({ error: 'Only the host can start' })
    if (room.players.length < 3) return callback?.({ error: 'Need at least 3 players' })
    if (room.gameState !== 'LOBBY') return callback?.({ error: 'Game already in progress' })

    startRound(room)
    console.log(`🎮 Round started in ${room.roomCode} | Imposter: ${room.roundData.imposterId}`)
    console.log(`   Words: "${room.roundData.wordPair.mainWord}" / "${room.roundData.wordPair.imposterWord}"`)

    callback?.({ success: true })

    room.players.forEach(player => {
      const revealData = getPlayerRevealData(room, player.id)
      if (revealData) {
        io.to(player.id).emit('game-started', revealData)
        console.log(`📤 Sent game-started to ${player.name} (${player.id})`)
      } else {
        console.log(`⚠️ Missing reveal data for ${player.name} (${player.id})`)
      }
    })
  })

  // ── Player Ready (after viewing card) ────────────────────
  socket.on('player-ready', (callback) => {
    const room = getRoomBySocketId(socket.id)
    if (!room || room.gameState !== 'REVEAL') {
      return callback?.({ error: 'Not in reveal phase' })
    }

    const result = setPlayerReady(room, socket.id)
    if (!result) return callback?.({ error: 'Round data not found' })

    callback?.({ success: true })

    io.to(room.roomCode).emit('ready-update', {
      readyCount: result.readyCount,
      totalCount: result.totalCount,
      readyPlayerIds: room.roundData.readyPlayers,
    })

    console.log(`✅ ${socket.id} ready (${result.readyCount}/${result.totalCount}) in ${room.roomCode}`)

    // All ready → start clue round
    if (result.allReady) {
      room.gameState = 'CLUE_ROUND'
      const clueState = getClueRoundState(room)
      io.to(room.roomCode).emit('clue-round-started', clueState)
      console.log(`📝 Clue round started in ${room.roomCode}`)
    }
  })

  // ── Submit Clue (Phase 5) ────────────────────────────────
  socket.on('submit-clue', ({ clue }, callback) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return callback?.({ error: 'Room not found' })

    const result = submitClue(room, socket.id, clue)
    if (result.error) return callback?.({ error: result.error })

    const player = room.players.find(p => p.id === socket.id)
    console.log(`💬 ${player?.name} submitted clue in ${room.roomCode}`)

    callback?.({ success: true })

    // Broadcast updated clue round state to all players
    const clueState = getClueRoundState(room)
    io.to(room.roomCode).emit('clue-round-update', clueState)

    // If clue round complete, notify transition to voting
    if (result.clueRoundComplete) {
      console.log(`🗳️  Clue round complete in ${room.roomCode} — moving to VOTING`)
      io.to(room.roomCode).emit('clue-round-complete', {
        gameState: 'VOTING',
        clues: room.roundData.clues,
        players: room.players.map(p => ({
          id: p.id,
          name: p.name,
          isHost: p.id === room.hostId,
        })),
      })
    }
  })

  // ── Submit Vote ──────────────────────────────────────────
  socket.on('submit-vote', ({ targetId }, callback) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return callback?.({ error: 'Room not found' })

    const result = submitVote(room, socket.id, targetId)
    if (result.error) return callback?.({ error: result.error })

    const player = room.players.find(p => p.id === socket.id)
    console.log(`🗳️  ${player?.name} voted in ${room.roomCode} (${result.votedCount}/${result.totalCount})`)

    callback?.({ success: true })

    // Broadcast vote progress
    io.to(room.roomCode).emit('vote-update', {
      votedCount: result.votedCount,
      totalCount: result.totalCount,
    })

    // If all voted, resolve and broadcast results
    if (result.allVoted) {
      const voteResult = resolveVotes(room)
      console.log(`📊 Votes resolved in ${room.roomCode} | Voted out: ${voteResult.votedOutId} | Imposter caught: ${voteResult.imposterCaught}`)

      io.to(room.roomCode).emit('vote-result', voteResult)
    }
  })

  // ── Final Guess (imposter caught) ────────────────────────
  socket.on('final-guess', ({ guess }, callback) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return callback?.({ error: 'Room not found' })

    // Only the imposter can guess
    if (socket.id !== room.roundData?.imposterId) {
      return callback?.({ error: 'Only the imposter can guess' })
    }

    const result = submitFinalGuess(room, guess)
    if (result.error) return callback?.({ error: result.error })

    console.log(`🎯 Final guess in ${room.roomCode}: "${result.finalGuess}" — ${result.correct ? 'CORRECT' : 'WRONG'}`)

    callback?.({ success: true })

    io.to(room.roomCode).emit('final-guess-result', {
      finalGuess: result.finalGuess,
      correct: result.correct,
      winner: result.winner,
      wordPair: result.wordPair,
    })
  })

  // ── Restart Round (Phase 7) ───────────────────────────────
  socket.on('restart_round', (callback) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) {
      console.log(`❌ Restart failed: Room not found for socket ${socket.id}`)
      return callback?.({ error: 'Room session lost. Please create a new room.' })
    }

    // Only host can restart
    if (room.hostId !== socket.id) {
      return callback?.({ error: 'Only the host can start a new round' })
    }

    // Must be in RESULT state to restart
    if (room.gameState !== 'RESULT') {
      return callback?.({ error: 'Cannot restart while game is active' })
    }

    // Authoritative state transition
    startRound(room)
    console.log(`🔄 [${room.roomCode}] Round restarted by host ${socket.id}`)

    callback?.({ success: true })

    // 1. Synchronized Room-wide update (shared data only)
    io.to(room.roomCode).emit('round_restarted', {
      gameState: room.gameState, // 'REVEAL'
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId,
      })),
    })

    // 2. Individual Private word delivery
    room.players.forEach(player => {
      const revealData = getPlayerRevealData(room, player.id)
      if (revealData) {
        io.to(player.id).emit('game-started', revealData)
      }
    })
  })

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    handleDisconnect(socket)
    console.log(`💤 Disconnected: ${socket.id}`)
  })
})

function handleDisconnect(socket) {
  const result = leaveRoom(socket.id)
  if (!result) return

  const { roomCode, room, removedPlayerName } = result
  socket.leave(roomCode)

  if (room) {
    // Clean up during reveal
    if (room.gameState === 'REVEAL' && room.roundData) {
      room.roundData.readyPlayers = room.roundData.readyPlayers.filter(id => id !== socket.id)
    }

    // Clean up during clue round
    if (room.gameState === 'CLUE_ROUND' && room.roundData) {
      handleClueDisconnect(room, socket.id)
      const clueState = getClueRoundState(room)
      io.to(roomCode).emit('clue-round-update', clueState)

      if (room.roundData.clueRoundComplete) {
        clearTimeout(room.roundData.clueTimer);
        io.to(roomCode).emit('clue-reveal-started', clueState)
      }
    }

    // Clean up during voting
    if (room.gameState === 'VOTING' && room.roundData) {
      const allVoted = room.players.every(p => room.roundData.votedPlayers.includes(p.id))
      if (allVoted) {
        const voteResult = resolveVotes(room)
        io.to(roomCode).emit('vote-result', voteResult)
      } else {
        io.to(roomCode).emit('vote-update', {
          votedCount: room.roundData.votedPlayers.filter(id => room.players.some(p => p.id === id)).length,
          totalCount: room.players.length,
        })
      }
    }

    io.to(roomCode).emit('lobby-update', {
      players: room.players,
      hostId: room.hostId,
    })
    console.log(`👋 ${removedPlayerName} left room ${roomCode}`)
  } else {
    console.log(`🗑️  Room ${roomCode} deleted (empty)`)
  }
}

server.listen(PORT, () => {
  console.log(`\n🚀 SusWord server running on http://localhost:${PORT}\n`)
})
