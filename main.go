package main

import (
	"context"
	"embed"
	"log"

	"github.com/dpicillo/LDAPilot/internal/config"
	"github.com/dpicillo/LDAPilot/internal/ldap"
	"github.com/dpicillo/LDAPilot/services"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
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

	// Wire up schema cache cleanup on disconnect
	connectionService.SetSchemaService(schemaService)
	// Wire up audit store for cascade delete and change logging
	connectionService.SetAuditStore(auditStore)
	editorService.SetAuditStore(auditStore)

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
		Frameless:        true,
		BackgroundColour: &options.RGBA{R: 30, G: 30, B: 30, A: 1},
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
		},
		OnShutdown: func(ctx context.Context) {
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
		},
	})

	if err != nil {
		log.Fatalf("Error: %v", err)
	}
}
