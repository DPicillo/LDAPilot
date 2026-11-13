package main

import (
	"context"
	"embed"
	"log"
	"os"

	"github.com/dpicillo/LDAPilot/internal/ai/mcprelay"
	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/services"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
)

//go:embed all:frontend/dist
var assets embed.FS

// appIcon is the window / taskbar icon on Linux (Windows and macOS take it
// from build/windows/icon.ico and the bundle icon generated from appicon.png).
// 256 px: GDK leaves out icons larger than one X request (the 1024 px
// appicon.png never reached _NET_WM_ICON).
//
//go:embed build/linux/icon.png
var appIcon []byte

// Build stamp, set by scripts/build.sh, i.e.
//
//	wails build -ldflags "-X main.version=v0.5.0 -X main.commit=$(git rev-parse --short HEAD) -X main.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
//
// Wails builds with -buildvcs=false, so the Go build info fallback (VCS
// revision and time, see UIService.GetAppInfo) only applies to a plain
// `go build`; an unstamped wails build reports services.ReleaseVersion +
// "-dev" (About: "v0.5.0 development build").
var (
	version = ""
	commit  = ""
	date    = ""
)

func main() {
	// Claude Code inside WSL starts LDAPilot.exe as the stdio relay to the
	// run's tool server (internal/ai/mcprelay): relay and exit before any
	// part of the app (config, window) starts.
	if len(os.Args) >= 2 && os.Args[1] == mcprelay.Flag {
		os.Exit(mcprelay.Main(os.Args[2:]))
	}

	// Lets the Windows setup see that LDAPilot runs (after the relay branch,
	// so a running relay never blocks an update).
	holdAppMutexes()

	// Initialize config store
	store, err := config.NewStore()
	if err != nil {
		log.Fatalf("Failed to initialize config store: %v", err)
	}

	// Initialize connection pool
	pool := ldap.NewPool()

	// Initialize audit store
	auditStore := config.NewAuditStore()

	// Initialize AI config store
	aiConfigStore, err := config.NewAIConfigStore()
	if err != nil {
		log.Fatalf("Failed to initialize AI config store: %v", err)
	}

	// Initialize chat store
	chatStore, err := config.NewChatStore()
	if err != nil {
		log.Fatalf("Failed to initialize chat store: %v", err)
	}

	// Create services
	connectionService := services.NewConnectionService(store, pool)
	browserService := services.NewBrowserService(pool)
	editorService := services.NewEditorService(pool)
	searchService := services.NewSearchService(pool)
	exportService := services.NewExportService(pool)
	schemaService := services.NewSchemaService(pool)
	logService := services.NewLogService(pool)
	auditService := services.NewAuditService(auditStore)
	aiService := services.NewAIService(pool, aiConfigStore, chatStore)
	batchService := services.NewBatchService(pool, logService)
	uiService := services.NewUIService()
	uiService.SetBuildInfo(version, commit, date)

	// Wire up schema cache cleanup on disconnect
	connectionService.SetSchemaService(schemaService)
	// Wire up audit store for cascade delete and change logging
	connectionService.SetAuditStore(auditStore)
	editorService.SetAuditStore(auditStore)
	batchService.SetAuditStore(auditStore)
	exportService.SetAuditStore(auditStore)
	aiService.SetAuditStore(auditStore)

	// Create application with options
	err = wails.Run(&options.App{
		Title:     "LDAPilot",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		Frameless: true,
		// The theme's --background (dark #16181d, light #ffffff) of the last
		// run (UIService.SetTheme), so the window never flashes the other
		// theme before the page paints; the frontend repaints it on every
		// theme change (WindowSetBackgroundColour).
		BackgroundColour: windowBackground(config.LoadUIState().Theme),
		Linux: &linux.Options{
			Icon: appIcon,
			// The Wayland app ID and X11 window name; equal to the desktop
			// entry's name, so docks and panels show the LDAPilot icon.
			ProgramName: appID,
			// What Wails uses when Linux is nil (wails#2977); a non-nil
			// Options would otherwise switch to "on demand".
			WebviewGpuPolicy: linux.WebviewGpuPolicyNever,
		},
		OnStartup: func(ctx context.Context) {
			connectionService.SetContext(ctx)
			browserService.SetContext(ctx)
			editorService.SetContext(ctx)
			searchService.SetContext(ctx)
			exportService.SetContext(ctx)
			schemaService.SetContext(ctx)
			logService.SetContext(ctx)
			auditService.SetContext(ctx)
			aiService.SetContext(ctx)
			batchService.SetContext(ctx)
			uiService.SetContext(ctx)
		},
		// Closing the window asks the frontend first (bulk run, recursive
		// delete, unsaved edits: "Quit anyway?"); it closes anyway when the
		// frontend does not answer within 2 s or on a second close request.
		OnBeforeClose: uiService.BeforeClose,
		OnShutdown: func(ctx context.Context) {
			aiService.Shutdown()
			pool.DisconnectAll()
		},
		Bind: []interface{}{
			connectionService,
			browserService,
			editorService,
			searchService,
			exportService,
			schemaService,
			logService,
			auditService,
			aiService,
			batchService,
			uiService,
		},
	})

	if err != nil {
		log.Fatalf("Error: %v", err)
	}
}

// windowBackground is the native window colour for a resolved theme
// ("light", anything else = dark), matching the --background token.
func windowBackground(theme string) *options.RGBA {
	if theme == "light" {
		return &options.RGBA{R: 255, G: 255, B: 255, A: 1}
	}
	return &options.RGBA{R: 22, G: 24, B: 29, A: 1}
}
