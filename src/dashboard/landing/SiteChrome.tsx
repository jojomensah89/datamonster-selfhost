import { useCallback, useEffect, useRef, useState } from 'react';
import { Spike } from '../components/Spike';
import { SpikeCharacter, type SpikeMood, type SpikeTrigger } from '../components/SpikeCharacter';
import { api, type PlanInfo } from '../lib/api';

/** Hosted sign-in. Everyone lands on their websites; with ?plan=pro, on Billing. */
export const SIGN_IN_URL = '/api/auth/google';

export function usePlan() {
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => {
    api<PlanInfo>('/api/public/plan').then(setPlan, () => {});
  }, []);
  return plan;
}

export function SiteNav({ hosted, error = null }: { hosted: boolean; error?: string | null }) {
  return (
    <div className="wrap">
      <nav className="nav" aria-label="Main">
        <a className="brand" href="/" aria-label="DataMonster home">
          <Spike size={30} />
          DataMonster
        </a>

        <ul className="nav-links">
          <li>
            <a href="/#ask">Ask AI</a>
          </li>
          <li>
            <a href="/#features">Features</a>
          </li>
          <li>
            <a href="/#pricing" data-dm-goal="pricing_cta" data-dm-goal-location="nav">
              Pricing
            </a>
          </li>
          <li>
            <a href="/#faq">FAQ</a>
          </li>
        </ul>

        <div className="nav-end">
          <a className="lp-btn" href={hosted ? SIGN_IN_URL : '/#pricing'} data-dm-goal={hosted ? 'signup_click' : 'pricing_cta'} data-dm-goal-location="nav-button">
            {hosted ? 'Sign in' : 'Get started'}
          </a>
        </div>
      </nav>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SiteFooter({ supportEmail }: { supportEmail: string | null }) {
  const year = new Date().getFullYear();

  const markRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const [footPhase, setFootPhase] = useState<'waiting' | 'hopping' | 'awake' | 'sleeping'>('waiting');
  const footPhaseRef = useRef(footPhase);
  footPhaseRef.current = footPhase;
  const [footTrigger, setFootTrigger] = useState<SpikeTrigger | null>(null);
  const seqRef = useRef(0);
  const enteredRef = useRef(false);
  const visibleRef = useRef(false);
  const sleepTimer = useRef(0);
  const greetTimer = useRef(0);
  const walkAnim = useRef<Animation | null>(null);

  const scheduleSleep = useCallback((delayMs: number) => {
    window.clearTimeout(sleepTimer.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!visibleRef.current || document.visibilityState === 'hidden') return;
    sleepTimer.current = window.setTimeout(() => {
      if (visibleRef.current && document.visibilityState !== 'hidden') {
        setFootPhase('sleeping');
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    const mark = markRef.current;
    if (!mark || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const finishWalk = () => {
      walkAnim.current = null;
      setFootPhase('awake');
      setFootTrigger({ kind: 'greet', key: ++seqRef.current });
      scheduleSleep(5500);
    };

    const startWalk = () => {
      const stage = stageRef.current;
      const word = wordRef.current;
      if (!stage || !word || typeof stage.animate !== 'function') {
        finishWalk();
        return;
      }
      const wordWidth = word.offsetWidth || 320;
      const wordHeight = word.offsetHeight || 64;
      // Travel along the open cobalt band just above the wordmark so white Spike never overlaps white letters.
      const liftY = -Math.round(wordHeight * 0.84);
      const startX = Math.round(Math.min(wordWidth * 0.72, 620));
      const hopPeak = Math.max(10, Math.round(wordHeight * 0.14));

      setFootPhase('hopping');
      const anim = stage.animate(
        [
          { transform: `translate3d(${startX}px, ${liftY}px, 0)`, offset: 0 },
          { transform: `translate3d(${Math.round(startX * 0.85)}px, ${liftY - hopPeak}px, 0)`, offset: 0.12 },
          { transform: `translate3d(${Math.round(startX * 0.68)}px, ${liftY}px, 0)`, offset: 0.24 },
          { transform: `translate3d(${Math.round(startX * 0.52)}px, ${liftY - hopPeak}px, 0)`, offset: 0.36 },
          { transform: `translate3d(${Math.round(startX * 0.36)}px, ${liftY}px, 0)`, offset: 0.48 },
          { transform: `translate3d(${Math.round(startX * 0.22)}px, ${liftY - Math.round(hopPeak * 0.9)}px, 0)`, offset: 0.6 },
          { transform: `translate3d(${Math.round(startX * 0.1)}px, ${liftY}px, 0)`, offset: 0.72 },
          { transform: `translate3d(${Math.round(startX * 0.03)}px, ${Math.round(liftY * 0.45) - hopPeak}px, 0)`, offset: 0.85 },
          { transform: 'translate3d(0, 2px, 0)', offset: 0.95 },
          { transform: 'translate3d(0, 0, 0)', offset: 1 },
        ],
        { duration: 1850, easing: 'linear', fill: 'none' },
      );
      walkAnim.current = anim;
      anim.onfinish = finishWalk;
    };

    const io = new IntersectionObserver(
      ([entry]) => {
        const isVis = entry ? entry.isIntersecting : false;
        visibleRef.current = isVis;
        if (isVis && !enteredRef.current) {
          enteredRef.current = true;
          startWalk();
        } else if (!isVis) {
          window.clearTimeout(sleepTimer.current);
        } else if (footPhaseRef.current === 'awake') {
          scheduleSleep(5500);
        }
      },
      { threshold: 0.25 },
    );
    io.observe(mark);

    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(sleepTimer.current);
      } else if (visibleRef.current && enteredRef.current) {
        scheduleSleep(5500);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.clearTimeout(sleepTimer.current);
      window.clearTimeout(greetTimer.current);
      walkAnim.current?.cancel();
      walkAnim.current = null;
    };
  }, [scheduleSleep]);

  const wakeFoot = (clicked: boolean) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (footPhase === 'hopping') return;
    window.clearTimeout(greetTimer.current);
    if (footPhase === 'sleeping') {
      setFootPhase('awake');
      setFootTrigger({ kind: 'surprised', key: ++seqRef.current });
      greetTimer.current = window.setTimeout(() => {
        setFootTrigger({ kind: 'greet', key: ++seqRef.current });
      }, 720);
      scheduleSleep(8500);
    } else if (clicked) {
      setFootTrigger({ kind: 'hop', key: ++seqRef.current });
      scheduleSleep(8500);
    } else {
      scheduleSleep(8500);
    }
  };

  const footMood: SpikeMood = footPhase === 'hopping' ? 'hop' : footPhase === 'sleeping' ? 'sleep' : 'idle';

  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-plate">
          <div className="foot-cols">
            <div>
              <h3>Product</h3>
              <ul>
                <li>
                  <a href="/#ask">Ask AI</a>
                </li>
                <li>
                  <a href="/#features">Features</a>
                </li>
                <li>
                  <a href="/#pricing">Pricing</a>
                </li>
                <li>
                  <a href="https://submitmystartup.com/" target="_blank" rel="noreferrer">
                    Directories
                  </a>
                </li>
                <li>
                  <a href={SIGN_IN_URL} data-dm-goal="signup_click" data-dm-goal-location="footer">
                    Sign in
                  </a>
                </li>
              </ul>
            </div>

            <div>
              <h3>Developers</h3>
              <ul>
                <li>
                  <a href="/llms.txt">llms.txt</a>
                </li>
                <li>
                  <a href="/api/agent/v1/openapi.json">OpenAPI</a>
                </li>
                <li>
                  <a href="/api/agent/v1/guide">Agent guide</a>
                </li>
              </ul>
            </div>

            <div>
              <h3>Legal</h3>
              <ul>
                <li>
                  <a href="/privacy">Privacy</a>
                </li>
                <li>
                  <a href="/terms">Terms</a>
                </li>
                <li>
                  <a href="/refund">Refunds</a>
                </li>
              </ul>
            </div>

            {supportEmail && (
              <div>
                <h3>Support</h3>
                <ul>
                  <li>
                    <a href={`mailto:${supportEmail}`}>Email us</a>
                  </li>
                </ul>
              </div>
            )}
          </div>

          <div
            ref={markRef}
            className="foot-mark rise"
            role="img"
            aria-label="DataMonster"
            onPointerEnter={(e) => e.pointerType === 'mouse' && wakeFoot(false)}
            onPointerMove={(e) => e.pointerType === 'mouse' && footPhaseRef.current === 'sleeping' && wakeFoot(false)}
          >
            <span ref={stageRef} className="foot-spike-stage">
              <SpikeCharacter
                size={240}
                className="foot-spike"
                mood={footMood}
                energy={2}
                trigger={footTrigger}
                onPoke={() => wakeFoot(true)}
              />
            </span>
            <span ref={wordRef} className="foot-word">DataMonster</span>
          </div>

          <p className="foot-last">© {year} DataMonster</p>
        </div>
      </div>
    </footer>
  );
}
