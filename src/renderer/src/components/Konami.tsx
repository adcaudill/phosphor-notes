/**
 * Activate with: Up Up Down Down Left Right Left Right B A
 *
 * Controls:
 * - Arrow Keys: Rotate and Thrust
 * - Space: Fire
 * - H: Hyperspace
 * - ESC: Exit Game
 */

import React, { useEffect, useRef } from 'react';
import '../styles/Konami.css';

interface Vector2 {
  x: number;
  y: number;
}

interface GameObject {
  position: Vector2;
  velocity: Vector2;
  rotation?: number;
}

interface Bullet extends GameObject {
  lifetime: number;
  source: 'player' | 'saucer';
}

interface Asteroid extends GameObject {
  size: 'large' | 'medium' | 'small';
  radius: number;
}

interface Saucer extends GameObject {
  size: 'large' | 'small';
  fireTimer: number;
  radius: number;
}

interface Spaceship extends GameObject {
  rotation: number;
  isThrusting: boolean;
  invulnerability: number;
  fireTimer: number;
}

const Konami: React.FC<{
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameStateRef = useRef({
    spaceship: {
      position: { x: 400, y: 300 },
      velocity: { x: 0, y: 0 },
      rotation: 0,
      isThrusting: false,
      invulnerability: 120,
      fireTimer: 0
    } as Spaceship,
    bullets: [] as Bullet[],
    asteroids: [] as Asteroid[],
    saucers: [] as Saucer[],
    score: 0,
    level: 1,
    lives: 3,
    saucerSpawnTimer: 0,
    gameOver: false,
    isPaused: false
  });

  const keysRef = useRef({
    ArrowUp: false,
    ArrowDown: false,
    ArrowLeft: false,
    ArrowRight: false,
    ' ': false,
    h: false
  });

  // Initialize game
  useEffect(() => {
    if (!isOpen) return;

    const gameState = gameStateRef.current;
    gameState.asteroids = createAsteroids(gameState.level);
    gameState.score = 0;
    gameState.lives = 3;
    gameState.gameOver = false;

    const handleKeyDown = (e: KeyboardEvent): void => {
      const key = e.key;
      if (
        key === ' ' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'ArrowLeft' ||
        key === 'ArrowRight'
      ) {
        keysRef.current[key as keyof typeof keysRef.current] = true;
        e.preventDefault();
      }
      if (key.toLowerCase() === 'h') {
        keysRef.current.h = true;
      }
      if (key === 'Escape') {
        onClose();
      }
    };

    const handleKeyUp = (e: KeyboardEvent): void => {
      const key = e.key;
      if (
        key === ' ' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'ArrowLeft' ||
        key === 'ArrowRight'
      ) {
        keysRef.current[key as keyof typeof keysRef.current] = false;
      }
      if (key.toLowerCase() === 'h') {
        keysRef.current.h = false;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isOpen, onClose]);

  // Game loop
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const gameState = gameStateRef.current;
    let animationId: number;

    const createAsteroidsFromHit = (asteroid: Asteroid): Asteroid[] => {
      const newAsteroids: Asteroid[] = [];
      if (asteroid.size === 'large') {
        newAsteroids.push(createAsteroid('medium', asteroid.position.x - 30, asteroid.position.y));
        newAsteroids.push(createAsteroid('medium', asteroid.position.x + 30, asteroid.position.y));
      } else if (asteroid.size === 'medium') {
        newAsteroids.push(createAsteroid('small', asteroid.position.x - 20, asteroid.position.y));
        newAsteroids.push(createAsteroid('small', asteroid.position.x + 20, asteroid.position.y));
      }
      return newAsteroids;
    };

    const update = (): void => {
      if (gameState.gameOver || gameState.isPaused) return;

      const ship = gameState.spaceship;

      // Handle input
      if (keysRef.current.ArrowLeft) ship.rotation -= 0.2;
      if (keysRef.current.ArrowRight) ship.rotation += 0.2;
      if (keysRef.current.ArrowUp) {
        ship.isThrusting = true;
        const thrustForce = 0.5;
        ship.velocity.x += Math.cos(ship.rotation) * thrustForce;
        ship.velocity.y += Math.sin(ship.rotation) * thrustForce;
        const maxSpeed = 8;
        const speed = Math.sqrt(ship.velocity.x ** 2 + ship.velocity.y ** 2);
        if (speed > maxSpeed) {
          ship.velocity.x = (ship.velocity.x / speed) * maxSpeed;
          ship.velocity.y = (ship.velocity.y / speed) * maxSpeed;
        }
      } else {
        ship.isThrusting = false;
      }

      // Hyperspace
      if (keysRef.current.h) {
        ship.position.x = Math.random() * canvas.width;
        ship.position.y = Math.random() * canvas.height;
        ship.velocity.x *= 0.5;
        ship.velocity.y *= 0.5;
        ship.invulnerability = 120;
        keysRef.current.h = false;
      }

      // Fire
      if (keysRef.current[' ']) {
        ship.fireTimer--;
        if (ship.fireTimer <= 0) {
          const bulletSpeed = 7;
          gameState.bullets.push({
            position: {
              x: ship.position.x + Math.cos(ship.rotation) * 15,
              y: ship.position.y + Math.sin(ship.rotation) * 15
            },
            velocity: {
              x: Math.cos(ship.rotation) * bulletSpeed + ship.velocity.x,
              y: Math.sin(ship.rotation) * bulletSpeed + ship.velocity.y
            },
            lifetime: 60,
            source: 'player'
          });
          ship.fireTimer = 6;
        }
      } else {
        ship.fireTimer = 0;
      }

      // Update ship position
      ship.position.x += ship.velocity.x;
      ship.position.y += ship.velocity.y;
      ship.velocity.x *= 0.99;
      ship.velocity.y *= 0.99;

      // Screen wrap
      if (ship.position.x < 0) ship.position.x = canvas.width;
      if (ship.position.x > canvas.width) ship.position.x = 0;
      if (ship.position.y < 0) ship.position.y = canvas.height;
      if (ship.position.y > canvas.height) ship.position.y = 0;

      // Update bullets
      gameState.bullets = gameState.bullets.filter((bullet) => {
        bullet.position.x += bullet.velocity.x;
        bullet.position.y += bullet.velocity.y;
        bullet.lifetime--;

        // Screen wrap bullets
        if (bullet.position.x < 0) bullet.position.x = canvas.width;
        if (bullet.position.x > canvas.width) bullet.position.x = 0;
        if (bullet.position.y < 0) bullet.position.y = canvas.height;
        if (bullet.position.y > canvas.height) bullet.position.y = 0;

        return bullet.lifetime > 0;
      });

      // Update asteroids
      gameState.asteroids.forEach((asteroid) => {
        asteroid.position.x += asteroid.velocity.x;
        asteroid.position.y += asteroid.velocity.y;

        // Screen wrap
        if (asteroid.position.x < -asteroid.radius)
          asteroid.position.x = canvas.width + asteroid.radius;
        if (asteroid.position.x > canvas.width + asteroid.radius)
          asteroid.position.x = -asteroid.radius;
        if (asteroid.position.y < -asteroid.radius)
          asteroid.position.y = canvas.height + asteroid.radius;
        if (asteroid.position.y > canvas.height + asteroid.radius)
          asteroid.position.y = -asteroid.radius;
      });

      // Collision detection: bullets vs asteroids
      for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        for (let j = gameState.asteroids.length - 1; j >= 0; j--) {
          const asteroid = gameState.asteroids[j];
          const dist = Math.hypot(
            bullet.position.x - asteroid.position.x,
            bullet.position.y - asteroid.position.y
          );
          if (dist < asteroid.radius) {
            // Award points
            const pointsMap = { large: 20, medium: 50, small: 100 };
            gameState.score += pointsMap[asteroid.size];

            // Remove bullet
            gameState.bullets.splice(i, 1);

            // Create new asteroids
            const newAsteroids = createAsteroidsFromHit(asteroid);
            gameState.asteroids.push(...newAsteroids);

            // Remove asteroid
            gameState.asteroids.splice(j, 1);
            break;
          }
        }
      }

      // Update saucers
      gameState.saucerSpawnTimer++;
      if (gameState.saucerSpawnTimer > 300 && gameState.saucers.length < 2) {
        const saucerSize = Math.random() > 0.7 ? 'small' : 'large';
        const side = Math.random() > 0.5;
        gameState.saucers.push({
          position: {
            x: side ? -20 : canvas.width + 20,
            y: 100 + Math.random() * (canvas.height - 200)
          },
          velocity: {
            x: (side ? 1 : -1) * (saucerSize === 'small' ? 3 : 2),
            y: (Math.random() - 0.5) * 2
          },
          size: saucerSize,
          fireTimer: 0,
          radius: saucerSize === 'small' ? 15 : 25
        });
        gameState.saucerSpawnTimer = 0;
      }

      gameState.saucers = gameState.saucers.filter((saucer) => {
        saucer.position.x += saucer.velocity.x;
        saucer.position.y += saucer.velocity.y;
        saucer.fireTimer++;

        // Fire at player with varying accuracy
        const accuracy = saucer.size === 'small' ? 0.7 : 0.3;
        if (saucer.fireTimer > (saucer.size === 'small' ? 20 : 40) && Math.random() < accuracy) {
          const angle = Math.atan2(
            ship.position.y - saucer.position.y,
            ship.position.x - saucer.position.x
          );

          const bulletSpeed = 4;
          const spawnOffset = saucer.radius + 5;

          gameState.bullets.push({
            position: {
              x: saucer.position.x + Math.cos(angle) * spawnOffset,
              y: saucer.position.y + Math.sin(angle) * spawnOffset
            },
            velocity: {
              x: Math.cos(angle) * bulletSpeed,
              y: Math.sin(angle) * bulletSpeed
            },
            lifetime: 80,
            source: 'saucer'
          });
          saucer.fireTimer = 0;
        }

        return (
          saucer.position.x > -50 &&
          saucer.position.x < canvas.width + 50 &&
          saucer.position.y > -50 &&
          saucer.position.y < canvas.height + 50
        );
      });

      // Collision detection: bullets vs saucers
      for (let i = gameState.bullets.length - 1; i >= 0; i--) {
        const bullet = gameState.bullets[i];
        for (let j = gameState.saucers.length - 1; j >= 0; j--) {
          const saucer = gameState.saucers[j];
          const dist = Math.hypot(
            bullet.position.x - saucer.position.x,
            bullet.position.y - saucer.position.y
          );
          if (dist < saucer.radius) {
            const pointsMap = { large: 200, small: 1000 };
            gameState.score += pointsMap[saucer.size];
            gameState.bullets.splice(i, 1);
            gameState.saucers.splice(j, 1);
            break;
          }
        }
      }

      // Collision detection: ship vs asteroids/saucers
      if (ship.invulnerability <= 0) {
        for (const asteroid of gameState.asteroids) {
          const dist = Math.hypot(
            ship.position.x - asteroid.position.x,
            ship.position.y - asteroid.position.y
          );
          if (dist < asteroid.radius + 12) {
            gameState.lives--;
            if (gameState.lives <= 0) {
              gameState.gameOver = true;
            } else {
              ship.position = { x: canvas.width / 2, y: canvas.height / 2 };
              ship.velocity = { x: 0, y: 0 };
              ship.invulnerability = 120;
            }
            break;
          }
        }

        for (const saucer of gameState.saucers) {
          const dist = Math.hypot(
            ship.position.x - saucer.position.x,
            ship.position.y - saucer.position.y
          );
          if (dist < saucer.radius + 12) {
            gameState.lives--;
            if (gameState.lives <= 0) {
              gameState.gameOver = true;
            } else {
              ship.position = { x: canvas.width / 2, y: canvas.height / 2 };
              ship.velocity = { x: 0, y: 0 };
              ship.invulnerability = 120;
            }
            break;
          }
        }

        // Collision detection: ship vs saucer bullets
        for (let i = gameState.bullets.length - 1; i >= 0; i--) {
          const bullet = gameState.bullets[i];
          if (bullet.source === 'saucer') {
            const dist = Math.hypot(
              ship.position.x - bullet.position.x,
              ship.position.y - bullet.position.y
            );
            if (dist < 12) {
              gameState.lives--;
              if (gameState.lives <= 0) {
                gameState.gameOver = true;
              } else {
                ship.position = { x: canvas.width / 2, y: canvas.height / 2 };
                ship.velocity = { x: 0, y: 0 };
                ship.invulnerability = 120;
              }
              gameState.bullets.splice(i, 1);
              break;
            }
          }
        }
      }

      ship.invulnerability--;

      // Check if all asteroids cleared
      if (gameState.asteroids.length === 0 && gameState.saucers.length === 0) {
        gameState.level++;
        gameState.asteroids = createAsteroids(gameState.level);
      }
    };

    const render = (): void => {
      // Clear canvas with subtle fade effect for trail
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const gameState = gameStateRef.current;
      const ship = gameState.spaceship;

      // Draw game objects with phosphor glow
      ctx.strokeStyle = '#FFFFFF';
      ctx.fillStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
      ctx.shadowBlur = 5;

      // Draw spaceship
      if (ship.invulnerability <= 0 || Math.floor(ship.invulnerability / 10) % 2 === 0) {
        ctx.save();
        ctx.translate(ship.position.x, ship.position.y);
        ctx.rotate(ship.rotation);

        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-12, -8);
        ctx.lineTo(-6, 0);
        ctx.lineTo(-12, 8);
        ctx.closePath();
        ctx.stroke();

        if (ship.isThrusting) {
          ctx.beginPath();
          ctx.moveTo(-6, -4);
          ctx.lineTo(-12 - Math.random() * 8, 0);
          ctx.lineTo(-6, 4);
          ctx.stroke();
        }

        ctx.restore();
      }

      // Draw bullets
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowBlur = 4;
      gameState.bullets.forEach((bullet) => {
        ctx.beginPath();
        ctx.arc(bullet.position.x, bullet.position.y, 1, 0, Math.PI * 2);
        ctx.fill();
      });

      // Draw asteroids
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 6;
      gameState.asteroids.forEach((asteroid) => {
        ctx.save();
        ctx.translate(asteroid.position.x, asteroid.position.y);

        ctx.beginPath();
        const points = asteroid.size === 'large' ? 8 : asteroid.size === 'medium' ? 6 : 5;
        for (let i = 0; i < points; i++) {
          const angle = (i / points) * Math.PI * 2;
          const variation = gameState.gameOver ? 0.9 : 0.8 + Math.random() * 0.2;
          const x = Math.cos(angle) * asteroid.radius * variation;
          const y = Math.sin(angle) * asteroid.radius * variation;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();

        ctx.restore();
      });

      // Draw saucers
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.shadowBlur = 6;
      gameState.saucers.forEach((saucer) => {
        ctx.beginPath();
        ctx.ellipse(
          saucer.position.x,
          saucer.position.y,
          saucer.radius,
          saucer.radius * 0.5,
          0,
          0,
          Math.PI * 2
        );
        ctx.stroke();

        // Draw saucer dome
        ctx.beginPath();
        ctx.arc(
          saucer.position.x,
          saucer.position.y - saucer.radius * 0.3,
          saucer.radius * 0.4,
          0,
          Math.PI,
          true
        );
        ctx.stroke();
      });

      ctx.shadowBlur = 0;

      // Draw score
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px Courier, monospace';
      ctx.fillText(`SCORE: ${gameState.score}`, 20, 40);
      ctx.fillText(`LIVES: ${gameState.lives}`, 20, 70);
      ctx.fillText(`LEVEL: ${gameState.level}`, canvas.width - 220, 40);

      if (gameState.gameOver) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 48px Courier, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 40);
        ctx.font = '24px Courier, monospace';
        ctx.fillText(`FINAL SCORE: ${gameState.score}`, canvas.width / 2, canvas.height / 2 + 20);
        ctx.fillText('Press ESC to exit', canvas.width / 2, canvas.height / 2 + 60);
        ctx.textAlign = 'left';
      }
    };

    const gameLoop = (): void => {
      update();
      render();
      animationId = requestAnimationFrame(gameLoop);
    };

    gameLoop();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="konami-modal-overlay" onClick={onClose}>
      <div className="konami-modal" onClick={(e) => e.stopPropagation()}>
        <button className="konami-close" onClick={onClose}>
          ✕
        </button>
        <canvas ref={canvasRef} className="konami-canvas" width={800} height={600} />
      </div>
    </div>
  );
};

function createAsteroid(size: 'large' | 'medium' | 'small', x: number, y: number): Asteroid {
  const sizeMap = {
    large: { radius: 40, speed: 1 },
    medium: { radius: 25, speed: 1.5 },
    small: { radius: 12, speed: 2 }
  };
  const config = sizeMap[size];

  return {
    position: { x, y },
    velocity: {
      x: (Math.random() - 0.5) * config.speed * 4,
      y: (Math.random() - 0.5) * config.speed * 4
    },
    size,
    radius: config.radius
  };
}

function createAsteroids(level: number): Asteroid[] {
  const asteroids: Asteroid[] = [];
  const count = 3 + Math.min(level - 1, 5);

  for (let i = 0; i < count; i++) {
    let x, y;
    do {
      x = Math.random() * 800;
      y = Math.random() * 600;
    } while (Math.hypot(x - 400, y - 300) < 150);

    asteroids.push(createAsteroid('large', x, y));
  }

  return asteroids;
}

export default Konami;
