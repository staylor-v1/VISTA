// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

jest.mock('flexlayout-react', () => {
  const React = require('react');

  class TestModel {
    constructor(json) {
      this.json = json;
    }

    toJson() {
      return this.json;
    }
  }

  const Model = {
    fromJson: (json) => new TestModel(json),
  };

  const Actions = {
    ADJUST_WEIGHTS: 'FlexLayout_AdjustWeights',
  };

  function TestTabSet({ tabset, factory }) {
    const initialSelected = Number.isFinite(tabset.selected) ? tabset.selected : 0;
    const [selected, setSelected] = React.useState(initialSelected);
    const tabs = Array.isArray(tabset.children) ? tabset.children : [];
    const selectedTab = tabs[Math.min(selected, Math.max(0, tabs.length - 1))];

    return (
      <section className="flexlayout__tabset" data-testid={tabset.id || undefined}>
        <div className="flexlayout__tabset_tabbar_outer" role="tablist">
          {tabs.map((tab, index) => (
            <button
              type="button"
              key={tab.id || tab.component || tab.name}
              className={`flexlayout__tab_button ${index === selected ? 'flexlayout__tab_button--selected' : ''}`}
              role="tab"
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
            >
              {tab.name}
            </button>
          ))}
        </div>
        <div className="flexlayout__tabset_content">
          {selectedTab
            ? factory({
              getComponent: () => selectedTab.component,
              getName: () => selectedTab.name,
            })
            : null}
        </div>
      </section>
    );
  }

  function Layout({ model, factory, onModelChange }) {
    const json = model.toJson();
    const tabsets = Array.isArray(json?.layout?.children) ? json.layout.children : [];

    const notifyResize = () => {
      const nextJson = {
        ...json,
        layout: {
          ...json.layout,
          children: tabsets.map((tabset, index) => ({
            ...tabset,
            weight: Number(tabset.weight || 0) + (index === 0 ? 40 : index === tabsets.length - 1 ? -20 : 0),
          })),
        },
      };
      model.json = nextJson;
      onModelChange?.(model, { type: Actions.ADJUST_WEIGHTS });
    };

    return (
      <div className="flexlayout__layout">
        {tabsets.map((tabset, index) => (
          <React.Fragment key={tabset.id}>
            {index > 0 && (
              <button
                type="button"
                data-testid={index === 1 ? 'inspection-divider-left' : 'inspection-divider-right'}
                onPointerDown={notifyResize}
                onPointerUp={notifyResize}
              >
                splitter
              </button>
            )}
            <TestTabSet tabset={tabset} factory={factory} />
          </React.Fragment>
        ))}
      </div>
    );
  }

  return { Actions, Layout, Model };
});

// Polyfill for crypto.randomUUID in Jest environment
if (typeof global.crypto === 'undefined') {
  global.crypto = {};
}
if (typeof global.crypto.randomUUID === 'undefined') {
  global.crypto.randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      const v = c === 'x' ? r : ((r & 0x3) | 0x8);
      return v.toString(16);
    });
  };
}

// Provide a minimal canvas mock for tests that trigger histogram rendering paths.
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
    drawImage: jest.fn(),
    getImageData: jest.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
    putImageData: jest.fn(),
    clearRect: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    closePath: jest.fn(),
    stroke: jest.fn(),
    fill: jest.fn(),
    setLineDash: jest.fn(),
    arc: jest.fn(),
    fillRect: jest.fn(),
    fillText: jest.fn(),
    }),
  });
}

// Reduce noisy console output from React Router future-flag warnings
// and expected app logs during tests, while preserving other warnings/errors.

const originalWarn = console.warn;
const originalLog = console.log;
const originalError = console.error;

beforeAll(() => {
	console.warn = (...args) => {
		const first = args[0];
		const message = typeof first === 'string' ? first : '';

		if (message.includes('React Router Future Flag Warning')) {
			return;
		}

		return originalWarn(...args);
	};

	console.log = (...args) => {
		const first = args[0];
		const message = typeof first === 'string' ? first : '';

		if (
			message.startsWith('Fetching images for project:') ||
			message.startsWith('Authentication is disabled or user is not logged in') ||
			message.startsWith('Starting download for image') ||
			message.startsWith('Trying endpoint:') ||
			message.startsWith('Direct image fetch failed') ||
			message.startsWith('Download completed successfully:') ||
			message.startsWith('App render count:')
		) {
			return;
		}

		return originalLog(...args);
	};

	console.error = (...args) => {
		const first = args[0];
		const message = typeof first === 'string' ? first : '';

		if (message.startsWith('Failed to load image with ID:') ||
			message.startsWith('Failed to load review statuses:')) {
			return;
		}

		return originalError(...args);
	};
});

afterAll(() => {
	console.warn = originalWarn;
	console.log = originalLog;
	console.error = originalError;
});
