#!/bin/bash
# deploy.sh
date +">>> %Y-%m-%d %H:%M:%S"

# 환경에 따른 프로젝트 URL 설정
if [ "$1" == "development" ] || [ "$1" == "local" ]; then
  PROJECT_REF="yiknxpjimfaltllwwgvv"  # MimboNodeDev
  ENV="development"
elif [ "$1" == "production" ]; then
  PROJECT_REF="idkvxjdremaaizflunrz"  # MimboNode
  ENV="production"
else
  echo "Invalid environment. Please use 'development', 'local', or 'production'."
  exit 1
fi

# 함수 배포 및 결과 확인 함수
deploy_function() {
  local func_name="$1"
  if supabase functions deploy "$func_name" --project-ref $PROJECT_REF; then
    echo ">>> $func_name 함수를 $1 에 배포 완료했습니다."
    return 0
  else
    echo ">>>$func_name 함수를 $1 에 배포 중 오류가 발생했습니다."
    return 1
  fi
}

# 함수명이 있는지 확인
if [ -n "$2" ]; then
  # 함수명이 있는 경우 해당 함수만 배포
  deploy_function "$2" "$3"
else
  # 함수명이 없으면 모든 함수 배포
  all_success=true
  for dir in supabase/functions/*/; do
    func_name="${dir%/}"
    func_name="${func_name##*/}"
    if ! deploy_function "$func_name"; then
      all_success=false
    fi
  done

  if $all_success; then
    echo "모든 함수를 성공적으로 배포 완료했습니다."
  else
    echo "일부 함수 배포 중 오류가 발생했습니다."
  fi
fi
