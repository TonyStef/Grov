/**
 * Memory Constellation Particle System
 * A subtle animated network representing AI memory nodes
 *
 * Features:
 * - 20-30 floating emerald particles
 * - Soft connections between nearby nodes
 * - Gentle breathing/pulsing effect
 * - Mouse magnetic attraction
 * - Responsive particle count (fewer on mobile)
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  baseRadius: number;
  pulseOffset: number;
}

interface ParticleSystemConfig {
  particleCount?: number;
  connectionDistance?: number;
  mouseRadius?: number;
  mouseForce?: number;
  speed?: number;
  color?: string;
}

class ParticleSystem {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private mouseX: number = -1000;
  private mouseY: number = -1000;
  private animationId: number | null = null;
  private config: Required<ParticleSystemConfig>;
  private time: number = 0;

  constructor(canvas: HTMLCanvasElement, config: ParticleSystemConfig = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');
    this.ctx = ctx;

    // Responsive particle count
    const isMobile = window.innerWidth < 768;
    const defaultParticleCount = isMobile ? 15 : 25;

    this.config = {
      particleCount: config.particleCount ?? defaultParticleCount,
      connectionDistance: config.connectionDistance ?? 150,
      mouseRadius: config.mouseRadius ?? 200,
      mouseForce: config.mouseForce ?? 0.02,
      speed: config.speed ?? 0.3,
      color: config.color ?? '#10b981',
    };

    this.init();
  }

  private init(): void {
    this.resize();
    this.createParticles();
    this.bindEvents();
    this.animate();
  }

  private resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.scale(dpr, dpr);
  }

  private createParticles(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    this.particles = [];
    for (let i = 0; i < this.config.particleCount; i++) {
      const radius = Math.random() * 2 + 1.5;
      this.particles.push({
        x: Math.random() * rect.width,
        y: Math.random() * rect.height,
        vx: (Math.random() - 0.5) * this.config.speed,
        vy: (Math.random() - 0.5) * this.config.speed,
        radius,
        baseRadius: radius,
        pulseOffset: Math.random() * Math.PI * 2,
      });
    }
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    this.canvas.addEventListener('mousemove', this.handleMouseMove);
    this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
  }

  private handleResize = (): void => {
    this.resize();
    this.createParticles();
  };

  private handleMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = e.clientX - rect.left;
    this.mouseY = e.clientY - rect.top;
  };

  private handleMouseLeave = (): void => {
    this.mouseX = -1000;
    this.mouseY = -1000;
  };

  private updateParticles(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    this.time += 0.02;

    for (const particle of this.particles) {
      // Apply mouse magnetic force
      const dx = this.mouseX - particle.x;
      const dy = this.mouseY - particle.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.config.mouseRadius && dist > 0) {
        const force = (this.config.mouseRadius - dist) / this.config.mouseRadius;
        particle.vx += (dx / dist) * force * this.config.mouseForce;
        particle.vy += (dy / dist) * force * this.config.mouseForce;
      }

      // Update position
      particle.x += particle.vx;
      particle.y += particle.vy;

      // Apply friction
      particle.vx *= 0.99;
      particle.vy *= 0.99;

      // Add some random movement
      particle.vx += (Math.random() - 0.5) * 0.02;
      particle.vy += (Math.random() - 0.5) * 0.02;

      // Breathing effect
      particle.radius = particle.baseRadius + Math.sin(this.time + particle.pulseOffset) * 0.5;

      // Bounce off edges with padding
      const padding = 50;
      if (particle.x < padding) {
        particle.x = padding;
        particle.vx *= -0.5;
      }
      if (particle.x > rect.width - padding) {
        particle.x = rect.width - padding;
        particle.vx *= -0.5;
      }
      if (particle.y < padding) {
        particle.y = padding;
        particle.vy *= -0.5;
      }
      if (particle.y > rect.height - padding) {
        particle.y = rect.height - padding;
        particle.vy *= -0.5;
      }
    }
  }

  private drawConnections(): void {
    const { connectionDistance, color } = this.config;

    for (let i = 0; i < this.particles.length; i++) {
      for (let j = i + 1; j < this.particles.length; j++) {
        const p1 = this.particles[i];
        const p2 = this.particles[j];
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < connectionDistance) {
          const opacity = (1 - dist / connectionDistance) * 0.3;
          this.ctx.beginPath();
          this.ctx.strokeStyle = this.hexToRgba(color, opacity);
          this.ctx.lineWidth = 1;
          this.ctx.moveTo(p1.x, p1.y);
          this.ctx.lineTo(p2.x, p2.y);
          this.ctx.stroke();
        }
      }
    }
  }

  private drawParticles(): void {
    const { color } = this.config;

    for (const particle of this.particles) {
      // Glow effect
      const gradient = this.ctx.createRadialGradient(
        particle.x, particle.y, 0,
        particle.x, particle.y, particle.radius * 3
      );
      gradient.addColorStop(0, this.hexToRgba(color, 0.8));
      gradient.addColorStop(0.5, this.hexToRgba(color, 0.2));
      gradient.addColorStop(1, this.hexToRgba(color, 0));

      this.ctx.beginPath();
      this.ctx.fillStyle = gradient;
      this.ctx.arc(particle.x, particle.y, particle.radius * 3, 0, Math.PI * 2);
      this.ctx.fill();

      // Core
      this.ctx.beginPath();
      this.ctx.fillStyle = color;
      this.ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }

  private hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private animate = (): void => {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;

    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.updateParticles();
    this.drawConnections();
    this.drawParticles();
    this.animationId = requestAnimationFrame(this.animate);
  };

  public destroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('mousemove', this.handleMouseMove);
    this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
  }
}

// Auto-initialize when DOM is ready
export function initParticleSystem(): void {
  const canvas = document.getElementById('memory-network') as HTMLCanvasElement;
  if (!canvas) return;

  new ParticleSystem(canvas);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initParticleSystem);
  } else {
    initParticleSystem();
  }
}

export { ParticleSystem };
