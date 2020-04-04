# conflibot

Post a warning if a Pull Request will conflict with other Pull Requests when they get merged.

## Configuration

```yaml
name: conflibot
on: pull_request

jobs:
  conflibot:
    runs-on: ubuntu-latest
    steps:
      - name: Post a conflict warning
        uses: wktk/conflibot@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```
