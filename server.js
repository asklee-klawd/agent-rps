const express = require('express');
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
    player1_move TEXT,
    player2_move TEXT,
    player1_bet REAL NOT NULL,
    player2_bet REAL,
    winner_did TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
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

// Active games waiting for player 2
const activeGames = new Map();

// Create new game
app.post('/api/game/create', async (req, res) => {
  try {
    const { token, bet, move } = req.body;

    // Verify AgentAuth token
    const verified = await AATToken.verify(token);
    const playerDID = verified.getAgent();

    // Validate bet
    if (!bet || bet <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    // Validate move
    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ error: 'Invalid move' });
    }

    // Create game
    const result = db.prepare(`
      INSERT INTO games (player1_did, player1_move, player1_bet)
      VALUES (?, ?, ?)
    `).run(playerDID, move, bet);

    const gameId = result.lastInsertRowid;

    // Add to active games
    activeGames.set(gameId, {
      player1: { did: playerDID, move, bet }
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

// Join existing game
app.post('/api/game/:gameId/join', async (req, res) => {
  try {
    const { gameId } = req.params;
    const { token, move } = req.body;

    // Verify AgentAuth token
    const verified = await AATToken.verify(token);
    const playerDID = verified.getAgent();

    // Get game
    const game = activeGames.get(parseInt(gameId));
    if (!game) {
      return res.status(404).json({ error: 'Game not found or already completed' });
    }

    // Can't join your own game
    if (game.player1.did === playerDID) {
      return res.status(400).json({ error: 'Cannot join your own game' });
    }

    // Validate move
    if (!['rock', 'paper', 'scissors'].includes(move)) {
      return res.status(400).json({ error: 'Invalid move' });
    }

    const bet = game.player1.bet; // Match player 1's bet

    // Update game
    db.prepare(`
      UPDATE games
      SET player2_did = ?, player2_move = ?, player2_bet = ?, completed_at = strftime('%s','now')
      WHERE id = ?
    `).run(playerDID, move, bet, gameId);

    // Determine winner
    const result = determineWinner(game.player1.move, move);
    let winnerDID = null;

    if (result === 'player1') {
      winnerDID = game.player1.did;
    } else if (result === 'player2') {
      winnerDID = playerDID;
    }

    // Update winner
    if (winnerDID) {
      db.prepare('UPDATE games SET winner_did = ? WHERE id = ?').run(winnerDID, gameId);
    }

    // Update leaderboard
    updateLeaderboard(game.player1.did, playerDID, winnerDID, bet);

    // Remove from active games
    activeGames.delete(parseInt(gameId));

    res.json({
      gameId,
      status: 'completed',
      player1: { did: game.player1.did, move: game.player1.move },
      player2: { did: playerDID, move },
      winner: winnerDID,
      pot: bet * 2,
      result: result === 'draw' ? 'Draw!' : `${winnerDID} wins!`
    });

  } catch (error) {
    console.error('Join game error:', error);
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
});
