FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home reader && chown -R reader:reader /app
USER reader
EXPOSE 8000
CMD ["python", "scripts/run.py", "--host", "0.0.0.0"]
