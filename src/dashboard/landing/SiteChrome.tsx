import { useEffect, useState } from 'react';
import { Button } from '../components/primitives/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/primitives/collapsible';
import { Spike } from '../components/Spike';
import { Icon } from '../components/ui';
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

export function SiteNav({
  page,
  hosted,
  loggedIn = false,
  error = null,
}: {
  page: 'landing' | 'directories';
  hosted: boolean;
  loggedIn?: boolean;
  error?: string | null;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isDirs = page === 'directories';
  const showLandingLinks = !isDirs || hosted;

  const ctaHref = isDirs
    ? loggedIn
      ? '/'
      : hosted
        ? SIGN_IN_URL
        : '/'
    : hosted
      ? SIGN_IN_URL
      : '/#pricing';

  const ctaLabel = isDirs
    ? loggedIn
      ? 'Dashboard'
      : 'Sign in'
    : hosted
      ? 'Sign in'
      : 'Get started';

  return (
    <div className="wrap">
      <Collapsible open={mobileOpen} onOpenChange={setMobileOpen}>
        <nav className="nav" aria-label="Main">
          <a className="brand" href="/" aria-label="DataMonster home">
            <Spike size={30} />
            DataMonster
          </a>

          {showLandingLinks ? (
            <ul className="nav-links">
              <li>
                <a href="/#ask">Ask AI</a>
              </li>
              <li>
                <a href="/#features">Features</a>
              </li>
              <li>
                <a href="/#pricing" data-dm-goal={!isDirs ? 'pricing_cta' : undefined} data-dm-goal-location={!isDirs ? 'nav' : undefined}>
                  Pricing
                </a>
              </li>
              <li>
                <a href="/#faq">FAQ</a>
              </li>
            </ul>
          ) : (
            <ul className="nav-minimal-links">
              <li>
                <a href="/directories" aria-current="page">
                  Directories
                </a>
              </li>
            </ul>
          )}

          <div className="nav-end">
            {isDirs && showLandingLinks && (
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="raw"
                  size="raw"
                  className="nav-menu-btn"
                  aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
                >
                  {mobileOpen ? <Icon name="close" size={16} /> : <Icon name="menu" size={16} />}
                  <span>Menu</span>
                </Button>
              </CollapsibleTrigger>
            )}
            <a
              className="lp-btn"
              href={ctaHref}
              data-dm-goal={!isDirs ? (hosted ? 'signup_click' : 'pricing_cta') : undefined}
              data-dm-goal-location={!isDirs ? 'nav-button' : undefined}
            >
              {ctaLabel}
            </a>
          </div>
        </nav>

        {isDirs && showLandingLinks && (
          <CollapsibleContent className="mobile-nav">
            <ul aria-label="Mobile navigation">
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
                <a href="/#faq">FAQ</a>
              </li>
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SiteFooter({
  page,
  hosted = true,
  loggedIn = false,
  supportEmail,
}: {
  page: 'landing' | 'directories';
  hosted?: boolean;
  loggedIn?: boolean;
  supportEmail: string | null;
}) {
  const isDirs = page === 'directories';
  const showLandingLinks = !isDirs || hosted;
  const year = new Date().getFullYear();

  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-plate">
          <div className="foot-cols">
            <div>
              <h3>Product</h3>
              <ul>
                {showLandingLinks && (
                  <>
                    <li>
                      <a href="/#ask">Ask AI</a>
                    </li>
                    <li>
                      <a href="/#features">Features</a>
                    </li>
                    <li>
                      <a href="/#pricing">Pricing</a>
                    </li>
                  </>
                )}
                <li>
                  <a href="/directories" aria-current={isDirs ? 'page' : undefined}>
                    Directories
                  </a>
                </li>
                {showLandingLinks && isDirs && (
                  <li>
                    <a href="/#faq">FAQ</a>
                  </li>
                )}
                <li>
                  <a
                    href={isDirs ? (loggedIn ? '/' : hosted ? SIGN_IN_URL : '/') : SIGN_IN_URL}
                    data-dm-goal={!isDirs ? 'signup_click' : undefined}
                    data-dm-goal-location={!isDirs ? 'footer' : undefined}
                  >
                    {isDirs && loggedIn ? 'Dashboard' : 'Sign in'}
                  </a>
                </li>
              </ul>
            </div>

            {isDirs ? (
              <div>
                <h3>Directory data</h3>
                <ul>
                  <li>
                    <a href="/directories.json">directories.json</a>
                  </li>
                  <li>
                    <a href="/directories.md">directories.md</a>
                  </li>
                  <li>
                    <a href="/llms.txt">llms.txt</a>
                  </li>
                </ul>
              </div>
            ) : (
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
            )}

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

          <div className={isDirs ? 'foot-mark' : 'foot-mark rise'} role="img" aria-label="DataMonster">
            <Spike size={240} className="foot-spike" />
            <span className="foot-word">DataMonster</span>
          </div>

          <p className="foot-last">© {year} DataMonster</p>
        </div>
      </div>
    </footer>
  );
}
