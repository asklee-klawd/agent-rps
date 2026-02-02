const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { AATToken } = require('@agentauth/core');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Initialize database
const db = new Database('rps.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player1_did TEXT NOT NULL,
    player2_did TEXT,
    player1_commitment TEXT NOT NULL,
    player2_commitment TEXT,
    player1_move TEXT,
    player2_move TEXT,
    player1_salt TEXT,
    player2_salt TEXT,
    player1_bet REAL NOT NULL,
    player2_bet REAL,
    winner_did TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    committed_at INTEGER,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS leaderboard (
    did TEXT PRIMARY KEY,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    total_won REAL DEFAULT 0,
    total_lost REAL DEFAULT 0
  );
`);

// Active games (commitment phase)
const activeGames = new Map();

// Games waiting for reveals
const committedGames = new Map();

// Helper: Hash commitment
function hashCommitment(move, salt) {
  return crypto.createHash('sha256').update(`${move}:${salt}`).digest('hex');
}

// Helper: Verify commitment
function verifyCommitment(move, salt, commitment) {
  return hashCommitment(move, salt) === commitment;
}

// Create new game (Player 1 commits)
app.post('/api/game/create', async (req, res) => {
  try {
    const { token, bet, commitment } = req.body;

    // Verify AgentAuth token
    const verified = await AATToken.verify(token);
    const playerDID = verified.getAgent();

    // Validate bet
    if (!bet || bet <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    // Validate commitment
    if (!commitment || typeof commitment !== 'string' || commitment.length !== 64) {
      return res.status(400).json({ error: 'Invalid commitment hash' });
    }

    // Create game
    const result = db.prepare(`
      INSERT INTO games (player1_did, player1_commitment, player1_bet)
      VALUES (?, ?, ?)
    `).run(playerDID, commitment, bet);

    const gameId = result.lastInsertRowid;

    // Add to active games
    activeGames.set(gameId, {
      player1: { did: playerDID, commitment, bet }
    });

    res.json({
      gameId,
      status: 'waiting',
      message: 'Game created. Waiting for opponent...'
    });

  } catch (error) {
    console.error('Create game error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Join existing game (Player 2 commits)
app.post('/api/game/:gameId/join', async (req, res) => {
  try {
    const { gameId } = req.params;
    const { token, commitment } = req.body;

    // Verify AgentAuth token
    const verified = await AATToken.verify(token);
    const playerDID = verified.getAgent();

    // Get game
    const game = activeGames.get(parseInt(gameId));
    if (!game) {
      return res.status(404).json({ error: 'Game not found or already committed' });
    }

    // Can't join your own game
    if (game.player1.did === playerDID) {
      return res.status(400).json({ error: 'Cannot join your own game' });
    }

    // Validate commitment
    if (!commitment || typeof commitment !== 'string' || commitment.length !== 64) {
      return res.status(400).json({ error: 'Invalid commitment hash' });
    }

    const bet = game.player1.bet;

    // Update game
    db.prepare(`
      UPDATE games
      SET player2_did = ?, player2_commitment = ?, player2_bet = ?, committed_at = strftime('%s','now')
      WHERE id = ?
    `).run(playerDID, commitment, bet, gameId);

    // Move to committed games
    committedGames.set(parseInt(gameId), {
      player1: game.player1,
      player2: { did: playerDID, commitment, bet }
    });
    activeGames.delete(parseInt(gameId));

    res.json({
      gameId,
      status: 'committed',
      message: 'Both players committed. Now reveal your moves!'
    });

  } catch (error) {
    console.error('Join game error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Reveal move (both players must reveal)
app.post('/api/game/:gameId/reveal', async (req, res) => {
  try {
    const { gameId } = req.params;
    const { token, move, salt } = req.body;

    // Verify AgentAuth token
    const verified = await AATToken.verify(token);
    const playerDID = verified.getAgent();

    // Validate move
    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ error: 'Invalid move' });
    }

    // Validate salt
    if (!salt || typeof salt !== 'string') {
      return res.status(400).json({ error: 'Invalid salt' });
    }

    // Get committed game
    const game = committedGames.get(parseInt(gameId));
    if (!game) {
      return res.status(404).json({ error: 'Game not found or not yet committed' });
    }

    // Determine which player
    const isPlayer1 = game.player1.did === playerDID;
    const isPlayer2 = game.player2.did === playerDID;

    if (!isPlayer1 && !isPlayer2) {
      return res.status(403).json({ error: 'You are not a player in this game' });
    }

    // Verify commitment
    const commitment = isPlayer1 ? game.player1.commitment : game.player2.commitment;
    if (!verifyCommitment(move, salt, commitment)) {
      return res.status(400).json({ error: 'Move does not match commitment. Cheating detected!' });
    }

    // Store reveal
    if (isPlayer1) {
      game.player1.move = move;
      game.player1.salt = salt;
      db.prepare('UPDATE games SET player1_move = ?, player1_salt = ? WHERE id = ?')
        .run(move, salt, gameId);
    } else {
      game.player2.move = move;
      game.player2.salt = salt;
      db.prepare('UPDATE games SET player2_move = ?, player2_salt = ? WHERE id = ?')
        .run(move, salt, gameId);
    }

    // Check if both revealed
    if (game.player1.move && game.player2.move) {
      // Determine winner
      const result = determineWinner(game.player1.move, game.player2.move);
      let winnerDID = null;

      if (result === 'player1') {
        winnerDID = game.player1.did;
      } else if (result === 'player2') {
        winnerDID = game.player2.did;
      }

      // Update winner
      db.prepare('UPDATE games SET winner_did = ?, completed_at = strftime(\'%s\',\'now\') WHERE id = ?')
        .run(winnerDID, gameId);

      // Update leaderboard
      updateLeaderboard(game.player1.did, game.player2.did, winnerDID, game.player1.bet);

      // Remove from committed games
      committedGames.delete(parseInt(gameId));

      res.json({
        gameId,
        status: 'completed',
        player1: { 
          did: game.player1.did, 
          move: game.player1.move,
          salt: game.player1.salt,
          commitment: game.player1.commitment
        },
        player2: { 
          did: game.player2.did, 
          move: game.player2.move,
          salt: game.player2.salt,
          commitment: game.player2.commitment
        },
        winner: winnerDID,
        pot: game.player1.bet * 2,
        result: result === 'draw' ? 'Draw!' : `${winnerDID} wins!`,
        proof: {
          verified: true,
          player1Hash: hashCommitment(game.player1.move, game.player1.salt),
          player2Hash: hashCommitment(game.player2.move, game.player2.salt)
        }
      });
    } else {
      res.json({
        gameId,
        status: 'revealed',
        message: `Your move revealed. Waiting for ${isPlayer1 ? 'Player 2' : 'Player 1'} to reveal...`
      });
    }

  } catch (error) {
    console.error('Reveal error:', error);
    res.status(400).json({ error: error.message });
  }
});

// List active games
app.get('/api/games/active', (req, res) => {
  const games = Array.from(activeGames.entries()).map(([id, game]) => ({
    id,
    bet: game.player1.bet,
    created: db.prepare('SELECT created_at FROM games WHERE id = ?').get(id).created_at
  }));

  res.json({ games });
});

// Get game status
app.get('/api/game/:gameId/status', (req, res) => {
  const { gameId } = req.params;
  const gid = parseInt(gameId);

  if (activeGames.has(gid)) {
    res.json({ status: 'waiting', message: 'Waiting for Player 2 to join' });
  } else if (committedGames.has(gid)) {
    const game = committedGames.get(gid);
    const revealed1 = !!game.player1.move;
    const revealed2 = !!game.player2.move;
    res.json({ 
      status: 'committed', 
      message: 'Both committed. Waiting for reveals...',
      player1Revealed: revealed1,
      player2Revealed: revealed2
    });
  } else {
    const dbGame = db.prepare('SELECT * FROM games WHERE id = ?').get(gid);
    if (dbGame && dbGame.completed_at) {
      res.json({ status: 'completed', message: 'Game finished' });
    } else {
      res.status(404).json({ error: 'Game not found' });
    }
  }
});

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  const leaders = db.prepare(`
    SELECT did, wins, losses, draws, total_won, total_lost,
           (total_won - total_lost) as net
    FROM leaderboard
    ORDER BY wins DESC, net DESC
    LIMIT 20
  `).all();

  res.json({ leaderboard: leaders });
});

// Helper: Determine winner
function determineWinner(move1, move2) {
  if (move1 === move2) return 'draw';
  
  const wins = {
    rock: 'scissors',
    paper: 'rock',
    scissors: 'paper'
  };

  return wins[move1] === move2 ? 'player1' : 'player2';
}

// Helper: Update leaderboard
function updateLeaderboard(p1DID, p2DID, winnerDID, bet) {
  // Ensure both players exist in leaderboard
  db.prepare(`
    INSERT OR IGNORE INTO leaderboard (did) VALUES (?)
  `).run(p1DID);
  db.prepare(`
    INSERT OR IGNORE INTO leaderboard (did) VALUES (?)
  `).run(p2DID);

  if (!winnerDID) {
    // Draw
    db.prepare('UPDATE leaderboard SET draws = draws + 1 WHERE did IN (?, ?)').run(p1DID, p2DID);
  } else {
    const loserDID = winnerDID === p1DID ? p2DID : p1DID;
    
    db.prepare(`
      UPDATE leaderboard 
      SET wins = wins + 1, total_won = total_won + ?
      WHERE did = ?
    `).run(bet * 2, winnerDID);

    db.prepare(`
      UPDATE leaderboard
      SET losses = losses + 1, total_lost = total_lost + ?
      WHERE did = ?
    `).run(bet, loserDID);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎮 Agent RPS running on http://localhost:${PORT}`);
  console.log(`🔒 Commit-reveal protocol enabled - cryptographically fair!`);
});
