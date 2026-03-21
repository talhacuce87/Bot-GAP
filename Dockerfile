# Dockerfile for Bot-GAP
FROM python:3.11-slim

# Set work directory
WORKDIR /app

# Install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy project files
COPY . .

# Expose port (if needed, e.g. for webhooks)
# EXPOSE 8080

# Set environment variables (optional, for production best practice)
# ENV DISCORD_TOKEN=your_token_here

# Start the bot
CMD ["python", "Main.py"]
