pi --no-skills --no-extensions -e ./src/index.ts --models "google-antigravity/*" '搜索今天btc价格'
pi --no-skills --no-extensions -e ./src/index.ts --models "google-gemini-cli/*" '搜索今天btc价格'
pi --no-skills --no-extensions -e ./src/index.ts --models "google/*" '搜索今天btc价格'

pi --no-skills --no-extensions -e ./src/index.ts --provider google-antigravity --model claude-sonnet-4-5 '搜索今天btc价格'
# ok
pi --no-skills --no-extensions -e ./src/index.ts --provider google-gemini-cli --model gemini-3-flash-preview '搜索今天btc价格'
# ok
pi --no-skills --no-extensions -e ./src/index.ts --provider google --model gemini-2.5-flash '搜索今天btc价格'