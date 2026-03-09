---
description: LDAPilot Development Workflow – build, run, test, and manage the project
---

// turbo-all

## Project Info
- **Stack**: Go 1.23+ backend (Wails v2) + React/TypeScript frontend (Vite)
- **Root**: `/home/dpicillo/git/LDAPilot`
- **Frontend**: `/home/dpicillo/git/LDAPilot/frontend`

---

## 1. Install Go Dependencies
```bash
cd /home/dpicillo/git/LDAPilot && go mod tidy
```

## 2. Install Frontend Dependencies
```bash
cd /home/dpicillo/git/LDAPilot/frontend && npm install
```

## 3. Run in Development Mode (Hot Reload)
```bash
cd /home/dpicillo/git/LDAPilot && wails dev -s -tags webkit2_41
```

## 4. Build Frontend Only
```bash
cd /home/dpicillo/git/LDAPilot/frontend && npm run build
```

## 5. Build Production Binary (Linux)
```bash
cd /home/dpicillo/git/LDAPilot && wails build -tags webkit2_41
```

## 6. Build Production Binary (Windows Cross-Compile)
```bash
cd /home/dpicillo/git/LDAPilot && wails build -platform windows/amd64 -tags webkit2_41
```

## 7. Run Go Tests
```bash
cd /home/dpicillo/git/LDAPilot && go test ./...
```

## 8. Run TypeScript Type Check
```bash
cd /home/dpicillo/git/LDAPilot/frontend && npx tsc --noEmit
```

## 9. Check Go Build (no output binary)
```bash
cd /home/dpicillo/git/LDAPilot && go build -tags webkit2_41 ./...
```

## 10. Go Vet
```bash
cd /home/dpicillo/git/LDAPilot && go vet -tags webkit2_41 ./...
```

---

## Docker Commands

### 11. Docker – List Running Containers
```bash
docker ps
```

### 12. Docker – List All Containers
```bash
docker ps -a
```

### 13. Docker – List Images
```bash
docker images
```

### 14. Docker – Build Image
```bash
docker build -t ldapilot:latest /home/dpicillo/git/LDAPilot
```

### 15. Docker – Run Container
```bash
docker run -d --name ldapilot ldapilot:latest
```

### 16. Docker – Stop Container
```bash
docker stop ldapilot
```

### 17. Docker – Remove Container
```bash
docker rm ldapilot
```

### 18. Docker – Remove Image
```bash
docker rmi ldapilot:latest
```

### 19. Docker – View Container Logs
```bash
docker logs ldapilot
```

### 20. Docker – Exec into Container
```bash
docker exec -it ldapilot /bin/bash
```

### 21. Docker Compose – Up
```bash
cd /home/dpicillo/git/LDAPilot && docker compose up -d
```

### 22. Docker Compose – Down
```bash
cd /home/dpicillo/git/LDAPilot && docker compose down
```

### 23. Docker Compose – Build + Up
```bash
cd /home/dpicillo/git/LDAPilot && docker compose up -d --build
```

### 24. Docker Compose – Logs
```bash
cd /home/dpicillo/git/LDAPilot && docker compose logs -f
```

### 25. Docker – System Prune (cleanup)
```bash
docker system prune -f
```

### 26. Docker – Network List
```bash
docker network ls
```

### 27. Docker – Volume List
```bash
docker volume ls
```

---

## Standard System Commands

### 28. Git – Status
```bash
cd /home/dpicillo/git/LDAPilot && git status
```

### 29. Git – Diff
```bash
cd /home/dpicillo/git/LDAPilot && git diff
```

### 30. Git – Log (last 10)
```bash
cd /home/dpicillo/git/LDAPilot && git log --oneline -n 10
```

### 31. Git – Add All
```bash
cd /home/dpicillo/git/LDAPilot && git add -A
```

### 32. Git – Commit
```bash
cd /home/dpicillo/git/LDAPilot && git commit -m "UPDATE_MESSAGE_HERE"
```

### 33. Git – Push
```bash
cd /home/dpicillo/git/LDAPilot && git push
```

### 34. Git – Pull
```bash
cd /home/dpicillo/git/LDAPilot && git pull
```

### 35. File Operations – List Directory
```bash
ls -la /home/dpicillo/git/LDAPilot
```

### 36. File Operations – Disk Usage
```bash
du -sh /home/dpicillo/git/LDAPilot
```

### 37. File Operations – Find Files
```bash
find /home/dpicillo/git/LDAPilot -name "PATTERN" -type f
```

### 38. Process – Check Ports
```bash
ss -tlnp
```

### 39. Process – Kill by Port
```bash
fuser -k PORT/tcp
```
