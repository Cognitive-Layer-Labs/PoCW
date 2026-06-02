FROM python:3.11-slim

WORKDIR /app

# CPU-only PyTorch
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# Inference-only Python deps
COPY requirements-inference.txt .
RUN pip install --no-cache-dir -r requirements-inference.txt

# Pre-bake the sentence-transformer embedding model so the container
# starts with no internet access at runtime.
RUN python3 -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-small-en-v1.5')"

# Bake the 2PL IRT model artifacts into the image.
# model/ must contain: xgb_regressors.pkl  irt_predictor.py
# To update the model, replace those files and rebuild.
COPY model ./model

COPY predictor_service.py .

ENV OMP_NUM_THREADS=1
ENV TRANSFORMERS_OFFLINE=1

EXPOSE 3001
CMD ["python3", "predictor_service.py", "--host", "0.0.0.0", "--port", "3001"]
